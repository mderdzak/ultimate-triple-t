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
//   GET    /games/:code?v=<tag>                        -> { state?, chat?, v } or { unchanged: true, v }
//   POST   /games/:code/join                           -> { token, role: 'O', state }
//   POST   /games/:code/move   { token, board, cell }  -> { state }
//   POST   /games/:code/chat   { token, text }         -> { chat }
//   DELETE /games/:code        { token }               -> { deleted: true }  (a player leaving, or a finished game)
//
// Chat lives in games/<code>/chat.json on its own branch (GITHUB_CHAT_BRANCH), so a
// chat message can never collide with a move being committed to the game branch.
//
// Nothing is kept once a game is over: the chat is deleted by the move that ends the
// game, the board as soon as the other player has seen the result, and both right away
// when a player leaves.
//
// Polling is cheap: the page sends back the `v` tag from its last reply, the worker
// asks GitHub "has this changed?" with conditional requests, and GitHub answers
// "304 Not Modified" without counting it against the hourly rate limit.

import { newBoardState, applyMove } from '../../js/game.js';

const FINISHED_GAME_TTL_MS = 10 * 60 * 1000;          // cron removes finished games after 10 minutes
const STALE_GAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // ...and abandoned games after 7 days
const MAX_NAME_LENGTH = 20;
const MAX_CHAT_LENGTH = 500;
const MAX_CHAT_MESSAGES = 100;

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
    const chatGh = github(env, chatBranch(env));
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
        await removeChat(chatGh, dir.name);
      }
    }

    // Chat files whose game is already gone.
    for (const dir of await chatGh.list('games').catch(() => [])) {
      if (dir.type !== 'dir') continue;
      if (!(await gh.read(`games/${dir.name}/state.json`))) await removeChat(chatGh, dir.name);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const gh = github(env);
  const chatGh = github(env, chatBranch(env));

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

  // GET /games/:code — current state and chat (used for polling)
  if (parts.length === 2 && request.method === 'GET') {
    const [stateTag, chatTag = ''] = (url.searchParams.get('v') || '').split('|');
    const [file, chatFile] = await Promise.all([
      gh.read(path, stateTag || undefined),
      readChat(chatGh, code, chatTag || undefined),
    ]);
    if (!file) throw new HttpError(404, 'No game with that code');

    // First look at this game's chat: create an empty file so later polls can be 304s.
    // A finished game's chat has already been deleted, so don't bring it back.
    let chat = chatFile;
    if (chat === 'missing' && (file.notModified || file.data.status !== 'active')) {
      chat = null;
    } else if (chat === 'missing') {
      await chatGh.write(`games/${code}/chat.json`, { messages: [] }, null, `Game ${code}: open chat`).catch(() => {});
      chat = { data: { messages: [] }, etag: '' };
    }

    const out = { v: `${file.etag || stateTag || ''}|${(chat && chat.etag) || chatTag}` };
    if (file.notModified && (!chat || chat.notModified)) return json({ unchanged: true, v: out.v });
    if (!file.notModified) out.state = publicState(file.data);
    if (chat && !chat.notModified) out.chat = chat.data.messages;
    return json(out);
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
    // Chat closes when the game ends, so it can go now. The board stays until the
    // other player has seen the result (they delete it), or the cron does.
    if (next.status === 'finished') await removeChat(chatGh, code);
    return json({ state: publicState(next) });
  }

  // POST /games/:code/chat — send a chat message
  if (parts.length === 3 && parts[2] === 'chat' && request.method === 'POST') {
    const body = await readJson(request);
    const file = await gh.read(path);
    if (!file) throw new HttpError(404, 'No game with that code');
    const role = await roleForToken(file.data, body.token);
    if (file.data.status !== 'active') throw new HttpError(409, 'The game is over');
    const text = cleanMessage(body.text);

    // Only other chat messages can race with this write, so just re-read and retry.
    const chatPath = `games/${code}/chat.json`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const chat = await chatGh.read(chatPath);
      const data = chat ? chat.data : { messages: [] };
      const last = data.messages[data.messages.length - 1];
      data.messages.push({ id: (last ? last.id : 0) + 1, from: role, text, at: new Date().toISOString() });
      if (data.messages.length > MAX_CHAT_MESSAGES) data.messages.splice(0, data.messages.length - MAX_CHAT_MESSAGES);
      const who = file.data.players[role].name;
      if (await chatGh.write(chatPath, data, chat ? chat.sha : null, `Game ${code}: ${who} chats`)) {
        return json({ chat: data.messages });
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
    throw new HttpError(409, 'Chat is busy, try sending again');
  }

  // DELETE /games/:code — a player left, or the game is over: remove the board and chat
  if (parts.length === 2 && request.method === 'DELETE') {
    const body = await readJson(request);
    const file = await gh.read(path);
    if (!file) {
      await removeChat(chatGh, code); // board already gone; make sure the chat is too
      return json({ deleted: true });
    }
    const role = await roleForToken(file.data, body.token);
    const why = file.data.status === 'finished' ? 'finished' : `${file.data.players[role].name} left`;
    await gh.remove(path, file.sha, `Game ${code} ${why}, removing folder`);
    await removeChat(chatGh, code);
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

function chatBranch(env) {
  return env.GITHUB_CHAT_BRANCH || 'game-chat';
}

// Chat is a nice-to-have: if it can't be read, the game keeps working without it.
// -> file | { notModified } | 'missing' | null (chat unavailable)
async function readChat(chatGh, code, tag) {
  try {
    return (await chatGh.read(`games/${code}/chat.json`, tag)) || 'missing';
  } catch {
    return null;
  }
}

async function removeChat(chatGh, code) {
  try {
    const path = `games/${code}/chat.json`;
    const file = await chatGh.read(path);
    if (file) await chatGh.remove(path, file.sha, `Game ${code} over, removing chat`);
  } catch {
    // The cron sweep picks up anything left behind.
  }
}

function cleanMessage(value) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim() : '';
  if (!text) throw new HttpError(400, 'Type a message first');
  if (text.length > MAX_CHAT_LENGTH) throw new HttpError(400, `Messages can be at most ${MAX_CHAT_LENGTH} characters`);
  return text;
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
function github(env, branchName) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, 'Worker is missing its GITHUB_TOKEN secret');
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const base = `${api}/repos/${env.GITHUB_REPO}/contents/`;
  const branch = branchName || env.GITHUB_BRANCH || 'game-data';
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
    // -> { data, sha, etag }, null if missing, or { notModified: true } when `etag`
    // (from an earlier read) still matches. GitHub doesn't count 304s against the rate limit.
    async read(path, etag) {
      const res = await call(`${path}?ref=${encodeURIComponent(branch)}`, {
        cache: 'no-store',
        headers: etag ? { 'If-None-Match': etag } : {},
      });
      if (res.status === 304) return { notModified: true };
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(502, `GitHub read failed (${res.status})`);
      const file = await res.json();
      return { data: JSON.parse(fromBase64(file.content)), sha: file.sha, etag: res.headers.get('etag') || '' };
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
