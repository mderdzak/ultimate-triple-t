// Relay between the website and GitHub.
//
// The website can't hold a GitHub token (anyone could read it from the page),
// so it calls this Cloudflare Worker instead. The worker keeps the token as a
// secret and reads/writes each game's file in the repo:
//
//   games/<6-digit code>/state.json   (on the GITHUB_BRANCH branch)
//
// Routes:
//   POST   /games              { hostName, guestName } -> { code, token, role: 'X', state }
//   GET    /games/:code                                -> { state }
//   POST   /games/:code/join                           -> { token, role: 'O', state }
//   POST   /games/:code/move   { token, board, cell }  -> { state }
//   DELETE /games/:code        { token }               -> { deleted: true }  (finished games only)

import { newBoardState, applyMove } from '../../js/game.js';

const FINISHED_GAME_TTL_MS = 60 * 60 * 1000;          // cron removes finished games after 1 hour
const STALE_GAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // ...and abandoned games after 7 days
const MAX_NAME_LENGTH = 20;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: err.message || 'Server error' }, status, cors);
    }
  },

  // Runs on the cron in wrangler.toml: removes games nobody will clean up.
  async scheduled(_event, env) {
    const gh = github(env);
    const dirs = await gh.list('games');
    const now = Date.now();
    for (const dir of dirs) {
      if (dir.type !== 'dir') continue;
      const file = await gh.read(`games/${dir.name}/state.json`);
      if (!file) continue;
      const age = now - Date.parse(file.data.updatedAt);
      const expired = file.data.status === 'finished' ? age > FINISHED_GAME_TTL_MS : age > STALE_GAME_TTL_MS;
      if (expired) {
        await gh.remove(`games/${dir.name}/state.json`, file.sha, `Clean up game ${dir.name}`);
      }
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const gh = github(env);

  if (parts[0] !== 'games') throw new HttpError(404, 'Not found');

  // POST /games — create a game
  if (parts.length === 1 && request.method === 'POST') {
    const body = await readJson(request);
    const hostName = cleanName(body.hostName);
    const guestName = cleanName(body.guestName);

    const token = randomToken();
    const now = new Date().toISOString();

    // Pick a code that isn't already in use. The create call is conditional
    // (no sha = "must not exist"), so a clash between two creates also fails safely.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = String(100000 + randomInt(900000));
      const state = {
        code,
        createdAt: now,
        updatedAt: now,
        players: {
          X: { name: hostName, tokenHash: await sha256(token) },
          O: { name: guestName, tokenHash: null },
        },
        ...newBoardState(),
      };
      const created = await gh.write(`games/${code}/state.json`, state, null, `Create game ${code}`);
      if (created) {
        return json({ code, token, role: 'X', state: publicState(state) }, 201);
      }
    }
    throw new HttpError(503, 'Could not find a free game code, try again');
  }

  const code = parts[1];
  if (!/^\d{6}$/.test(code || '')) throw new HttpError(400, 'Game codes are 6 digits');
  const path = `games/${code}/state.json`;

  // GET /games/:code — current state (used for polling)
  if (parts.length === 2 && request.method === 'GET') {
    const file = await gh.read(path);
    if (!file) throw new HttpError(404, 'No game with that code');
    return json({ state: publicState(file.data) });
  }

  // POST /games/:code/join — second player joins
  if (parts.length === 3 && parts[2] === 'join' && request.method === 'POST') {
    const file = await gh.read(path);
    if (!file) throw new HttpError(404, 'No game with that code');
    const state = file.data;
    if (state.players.O.tokenHash) throw new HttpError(409, 'Someone already joined this game');

    const token = randomToken();
    state.players.O.tokenHash = await sha256(token);
    state.updatedAt = new Date().toISOString();
    await saveOrConflict(gh, path, state, file.sha, `${state.players.O.name} joined game ${code}`);
    return json({ token, role: 'O', state: publicState(state) });
  }

  // POST /games/:code/move — play a move
  if (parts.length === 3 && parts[2] === 'move' && request.method === 'POST') {
    const body = await readJson(request);
    const file = await gh.read(path);
    if (!file) throw new HttpError(404, 'No game with that code');
    const state = file.data;

    const role = await roleForToken(state, body.token);
    if (state.status !== 'active') throw new HttpError(409, 'The game is over');
    if (state.turn !== role) throw new HttpError(409, "It's not your turn");

    let next;
    try {
      next = applyMove(state, body.board, body.cell);
    } catch {
      throw new HttpError(400, 'That move is not allowed');
    }
    next.updatedAt = new Date().toISOString();

    const who = state.players[role].name;
    await saveOrConflict(gh, path, next, file.sha, `Game ${code}: ${who} (${role}) plays board ${body.board + 1}, square ${body.cell + 1}`);
    return json({ state: publicState(next) });
  }

  // DELETE /games/:code — remove a finished game's folder
  if (parts.length === 2 && request.method === 'DELETE') {
    const body = await readJson(request);
    const file = await gh.read(path);
    if (!file) return json({ deleted: true }); // already gone
    await roleForToken(file.data, body.token);
    if (file.data.status !== 'finished') throw new HttpError(409, 'Only finished games can be deleted');
    await gh.remove(path, file.sha, `Game ${code} finished, removing folder`);
    return json({ deleted: true });
  }

  throw new HttpError(404, 'Not found');
}

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function saveOrConflict(gh, path, data, sha, message) {
  const ok = await gh.write(path, data, sha, message);
  if (!ok) throw new HttpError(409, 'The game changed at the same time, refresh and try again');
}

async function roleForToken(state, token) {
  if (typeof token !== 'string' || !token) throw new HttpError(403, 'Not a player in this game');
  const hash = await sha256(token);
  if (hash === state.players.X.tokenHash) return 'X';
  if (hash === state.players.O.tokenHash) return 'O';
  throw new HttpError(403, 'Not a player in this game');
}

// The repo is public, but there's no need to hand the token hashes to clients.
function publicState(state) {
  const copy = structuredClone(state);
  copy.players.X = { name: state.players.X.name, joined: true };
  copy.players.O = { name: state.players.O.name, joined: Boolean(state.players.O.tokenHash) };
  return copy;
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new HttpError(400, 'Both player names are required');
  if (name.length > MAX_NAME_LENGTH) throw new HttpError(400, `Names can be at most ${MAX_NAME_LENGTH} characters`);
  return name;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!isLocal && !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function randomInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

// Minimal GitHub "contents" API client.
function github(env) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, 'Worker is missing its GITHUB_TOKEN secret');
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const base = `${api}/repos/${env.GITHUB_REPO}/contents/`;
  const branch = env.GITHUB_BRANCH || 'game-data';
  const headers = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ultimate-triple-t-relay',
  };

  async function call(path, init = {}) {
    const res = await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') throw new HttpError(503, 'GitHub rate limit reached, try again in a few minutes');
    }
    return res;
  }

  return {
    // -> { data, sha } or null if missing
    async read(path) {
      const res = await call(`${path}?ref=${encodeURIComponent(branch)}`, { cache: 'no-store' });
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(502, `GitHub read failed (${res.status})`);
      const file = await res.json();
      return { data: JSON.parse(fromBase64(file.content)), sha: file.sha };
    },

    // sha = null means "create; fail if it exists". Returns false on a conflict.
    async write(path, data, sha, message) {
      const body = { message, content: toBase64(JSON.stringify(data, null, 2) + '\n'), branch };
      if (sha) body.sha = sha;
      const res = await call(path, { method: 'PUT', body: JSON.stringify(body) });
      if (res.status === 409 || res.status === 422) return false;
      if (!res.ok) throw new HttpError(502, `GitHub write failed (${res.status})`);
      return true;
    },

    async remove(path, sha, message) {
      const res = await call(path, { method: 'DELETE', body: JSON.stringify({ message, sha, branch }) });
      if (!res.ok && res.status !== 404) throw new HttpError(502, `GitHub delete failed (${res.status})`);
    },

    // Directory listing; [] if the directory doesn't exist.
    async list(path) {
      const res = await call(`${path}?ref=${encodeURIComponent(branch)}`, { cache: 'no-store' });
      if (res.status === 404) return [];
      if (!res.ok) throw new HttpError(502, `GitHub list failed (${res.status})`);
      return res.json();
    },
  };
}
