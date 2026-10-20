// Relay between the website and GitHub.
//
// The website can't hold a GitHub token (anyone could read it from the page),
// so it calls this Cloudflare Worker instead. The worker keeps the token as a
// secret and stores each game in the repo.
//
// Every game gets its own two BRANCHES, not just files:
//   game-<6-digit code>   state.json   the board and every move
//   chat-<6-digit code>   chat.json    the chat
// When a game ends or a player leaves, both branches are deleted. Deleting a branch
// (rather than a file on a shared branch) is what makes it permanent: the commits
// are no longer reachable from anything, so they don't stay behind in the history.
//
// Routes:
//   POST   /games              { hostName, guestName } -> { code, token, role: 'X', state }
//   GET    /games/:code?v=<tag>                        -> { state?, chat?, v } or { unchanged: true, v }
//   POST   /games/:code/join                           -> { token, role: 'O', state }
//   POST   /games/:code/move   { token, board, cell }  -> { state }
//   POST   /games/:code/chat   { token, text }         -> { chat }
//   DELETE /games/:code        { token }               -> { deleted: true }  (a player leaving, or done)
//
// When does a game disappear?
//   - a player leaves:   they forfeit, so the opponent is shown a win; deleted PURGE_DELAY_MS later
//                        (a game nobody has joined yet, or one that is already over, goes at once)
//   - the game ends:     PURGE_DELAY_MS after the last move (the other player's page also
//                        deletes it as soon as it has shown them the result)
//   - a tab just closes: the cron below catches finished games within a minute, and
//                        abandoned ones after STALE_GAME_TTL_MS
//
// Polling is cheap: the page sends back the `v` tag from its last reply, the worker
// asks GitHub "has this changed?" with conditional requests, and GitHub answers
// "304 Not Modified" without counting it against the hourly rate limit.

import { newBoardState, applyMove } from '../../js/game.js';

const PURGE_DELAY_MS = 10 * 1000;                     // a finished game is deleted this long after its last move
const STALE_GAME_TTL_MS = 7 * 24 * 60 * 60 * 1000;    // abandoned games are deleted after 7 days
const GAME_PREFIX = 'game-';                          // branch: game-<code>, file state.json
const CHAT_PREFIX = 'chat-';                          // branch: chat-<code>, file chat.json
const STATE_FILE = 'state.json';
const CHAT_FILE = 'chat.json';
const MAX_NAME_LENGTH = 20;
const MAX_CHAT_LENGTH = 500;
const MAX_CHAT_MESSAGES = 100;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      const res = await route(request, env, ctx);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: err.message || 'Server error' }, status, cors);
    }
  },

  // Runs every minute (cron in wrangler.toml): deletes games nobody else will clean up.
  async scheduled(_event, env) {
    const gh = github(env);
    const now = Date.now();
    const codes = codesOf(await gh.listBranches(GAME_PREFIX), GAME_PREFIX);
    for (const code of codes) {
      const file = await gh.read(gameBranch(code), STATE_FILE);
      if (!file) { await purgeGame(env, code); continue; }
      const age = now - Date.parse(file.data.updatedAt);
      const expired = file.data.status === 'finished' ? age > PURGE_DELAY_MS : age > STALE_GAME_TTL_MS;
      if (expired) await purgeGame(env, code);
    }

    // Chat branches whose game is already gone.
    const live = new Set(codes);
    for (const code of codesOf(await gh.listBranches(CHAT_PREFIX), CHAT_PREFIX)) {
      if (!live.has(code)) await gh.deleteBranch(chatBranch(code));
    }
  },
};

async function route(request, env, ctx) {
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
      // Each game gets its own branches so they can be deleted outright later.
      const created = await gh.createBranch(gameBranch(code), STATE_FILE, state, `Create game ${code}`);
      if (created) {
        await gh.createBranch(chatBranch(code), CHAT_FILE, { messages: [] }, `Game ${code}: open chat`);
        return json({ code, token, role: 'X', state: publicState(state) }, 201);
      }
    }
    throw new HttpError(503, 'Could not find a free game code, try again');
  }

  const code = parts[1];
  if (!/^\d{6}$/.test(code || '')) throw new HttpError(400, 'Game codes are 6 digits');
  const branch = gameBranch(code);

  // GET /games/:code — current state and chat (used for polling)
  if (parts.length === 2 && request.method === 'GET') {
    const [stateTag, chatTag = ''] = (url.searchParams.get('v') || '').split('|');
    const [file, chatFile] = await Promise.all([
      gh.read(branch, STATE_FILE, stateTag || undefined),
      readChat(gh, code, chatTag || undefined),
    ]);
    if (!file) throw new HttpError(404, 'No game with that code');

    // chat is null if it can't be read; the game keeps working without it.
    const chat = chatFile === 'missing' ? null : chatFile;
    const out = { v: `${file.etag || stateTag || ''}|${(chat && chat.etag) || chatTag}` };
    if (file.notModified && (!chat || chat.notModified)) return json({ unchanged: true, v: out.v });
    if (!file.notModified) out.state = publicState(file.data);
    if (chat && !chat.notModified) out.chat = chat.data.messages;
    return json(out);
  }

  // POST /games/:code/join — second player joins
  if (parts.length === 3 && parts[2] === 'join' && request.method === 'POST') {
    const file = await gh.read(branch, STATE_FILE);
    if (!file) throw new HttpError(404, 'No game with that code');
    const state = file.data;
    if (state.players.O.tokenHash) throw new HttpError(409, 'Someone already joined this game');

    const token = randomToken();
    state.players.O.tokenHash = await sha256(token);
    state.updatedAt = new Date().toISOString();
    await saveOrConflict(gh, branch, state, file.sha, `${state.players.O.name} joined game ${code}`);
    return json({ token, role: 'O', state: publicState(state) });
  }

  // POST /games/:code/move — play a move
  if (parts.length === 3 && parts[2] === 'move' && request.method === 'POST') {
    const body = await readJson(request);
    const file = await gh.read(branch, STATE_FILE);
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
    await saveOrConflict(gh, branch, next, file.sha, `Game ${code}: ${who} (${role}) plays board ${body.board + 1}, square ${body.cell + 1}`);
    // The game just ended: delete everything shortly after, once the other player has had
    // a moment to see the result. (Their page also deletes it as soon as it has shown them.)
    if (next.status === 'finished' && ctx) ctx.waitUntil(purgeAfterDelay(env, code));
    return json({ state: publicState(next) });
  }

  // POST /games/:code/chat — send a chat message
  if (parts.length === 3 && parts[2] === 'chat' && request.method === 'POST') {
    const body = await readJson(request);
    const file = await gh.read(branch, STATE_FILE);
    if (!file) throw new HttpError(404, 'No game with that code');
    const role = await roleForToken(file.data, body.token);
    if (file.data.status !== 'active') throw new HttpError(409, 'The game is over');
    const text = cleanMessage(body.text);

    // Only other chat messages can race with this write, so just re-read and retry.
    const cb = chatBranch(code);
    for (let attempt = 0; attempt < 4; attempt++) {
      const chat = await gh.read(cb, CHAT_FILE);
      const data = chat ? chat.data : { messages: [] };
      const last = data.messages[data.messages.length - 1];
      data.messages.push({ id: (last ? last.id : 0) + 1, from: role, text, at: new Date().toISOString() });
      if (data.messages.length > MAX_CHAT_MESSAGES) data.messages.splice(0, data.messages.length - MAX_CHAT_MESSAGES);
      const who = file.data.players[role].name;
      if (await gh.write(cb, CHAT_FILE, data, chat ? chat.sha : null, `Game ${code}: ${who} chats`)) {
        return json({ chat: data.messages });
      }
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
    throw new HttpError(409, 'Chat is busy, try sending again');
  }

  // DELETE /games/:code — a player leaves, or has seen the result
  if (parts.length === 2 && request.method === 'DELETE') {
    const body = await readJson(request);
    for (let attempt = 0; attempt < 3; attempt++) {
      const file = await gh.read(branch, STATE_FILE);
      if (!file) {
        await purgeGame(env, code); // already gone; also clears any chat branch left behind
        return json({ deleted: true });
      }
      const state = file.data;
      const role = await roleForToken(state, body.token);

      if (state.status === 'active' && state.players.O.tokenHash) {
        // Leaving a game in progress is a forfeit: record the opponent's win so their page can
        // show it, then delete everything shortly after (their page also deletes it as soon as
        // it has shown them).
        const winner = role === 'X' ? 'O' : 'X';
        state.status = 'finished';
        state.winner = winner;
        state.forfeitedBy = role;
        state.nextBoard = null;
        state.updatedAt = new Date().toISOString();
        const message = `Game ${code}: ${state.players[role].name} left, ${state.players[winner].name} wins`;
        if (!(await gh.write(branch, STATE_FILE, state, file.sha, message))) continue; // changed meanwhile: re-read
        if (ctx) ctx.waitUntil(purgeAfterDelay(env, code)); else await purgeGame(env, code);
        return json({ deleted: true });
      }

      // Nobody has joined yet, or the game is already over: nothing to forfeit.
      await purgeGame(env, code);
      return json({ deleted: true });
    }
    throw new HttpError(409, 'The game changed at the same time, try again');
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

async function saveOrConflict(gh, branch, data, sha, message) {
  const ok = await gh.write(branch, STATE_FILE, data, sha, message);
  if (!ok) throw new HttpError(409, 'The game changed at the same time, refresh and try again');
}

const gameBranch = (code) => `${GAME_PREFIX}${code}`;
const chatBranch = (code) => `${CHAT_PREFIX}${code}`;

// ['game-123456', ...] -> ['123456', ...]
function codesOf(branches, prefix) {
  return branches.map((b) => b.slice(prefix.length)).filter((c) => /^\d{6}$/.test(c));
}

// Delete both branches of a game. Nothing of it (board, moves, chat) stays reachable.
async function purgeGame(env, code) {
  const gh = github(env);
  await Promise.all([gh.deleteBranch(gameBranch(code)), gh.deleteBranch(chatBranch(code))]);
}

async function purgeAfterDelay(env, code) {
  await new Promise((resolve) => setTimeout(resolve, PURGE_DELAY_MS));
  try {
    await purgeGame(env, code);
  } catch (err) {
    console.error('purge failed, the cron will retry', err); // the minute cron catches it
  }
}

// Chat is a nice-to-have: if it can't be read, the game keeps working without it.
// -> file | { notModified } | 'missing' | null (chat unavailable)
async function readChat(gh, code, tag) {
  try {
    return (await gh.read(chatBranch(code), CHAT_FILE, tag)) || 'missing';
  } catch {
    return null;
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

// Minimal GitHub client: the contents API for reading/writing a file on a branch, and the
// git data API for creating and deleting whole branches.
function github(env) {
  if (!env.GITHUB_TOKEN) throw new HttpError(500, 'Worker is missing its GITHUB_TOKEN secret');
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const base = `${api}/repos/${env.GITHUB_REPO}/`;
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
  const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) });

  return {
    // -> { data, sha, etag }, null if missing, or { notModified: true } when `etag`
    // (from an earlier read) still matches. GitHub doesn't count 304s against the rate limit.
    async read(branch, path, etag) {
      const res = await call(`contents/${path}?ref=${encodeURIComponent(branch)}`, {
        cache: 'no-store',
        headers: etag ? { 'If-None-Match': etag } : {},
      });
      if (res.status === 304) return { notModified: true };
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(502, `GitHub read failed (${res.status})`);
      const file = await res.json();
      return { data: JSON.parse(fromBase64(file.content)), sha: file.sha, etag: res.headers.get('etag') || '' };
    },

    // Update a file that already exists. Returns false on a conflict (the file changed meanwhile).
    async write(branch, path, data, sha, message) {
      const body = { message, content: toBase64(JSON.stringify(data, null, 2) + '\n'), branch, sha };
      const res = await call(`contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
      if (res.status === 409 || res.status === 422) return false;
      if (!res.ok) throw new HttpError(502, `GitHub write failed (${res.status})`);
      return true;
    },

    // Create a brand-new branch whose only commit holds one file, with no parent, so it
    // shares no history with anything else. Returns false if the branch already exists.
    async createBranch(branch, path, data, message) {
      const content = JSON.stringify(data, null, 2) + '\n';
      const treeRes = await post('git/trees', { tree: [{ path, mode: '100644', type: 'blob', content }] });
      if (!treeRes.ok) throw new HttpError(502, `GitHub tree failed (${treeRes.status})`);
      const tree = await treeRes.json();
      const commitRes = await post('git/commits', { message, tree: tree.sha, parents: [] });
      if (!commitRes.ok) throw new HttpError(502, `GitHub commit failed (${commitRes.status})`);
      const commit = await commitRes.json();
      const refRes = await post('git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
      if (refRes.status === 422) return false; // branch exists
      if (!refRes.ok) throw new HttpError(502, `GitHub branch failed (${refRes.status})`);
      return true;
    },

    // Delete a branch and with it everything only that branch held. Fine if already gone.
    async deleteBranch(branch) {
      const res = await call(`git/refs/heads/${encodeURIComponent(branch)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404 && res.status !== 422) throw new HttpError(502, `GitHub delete failed (${res.status})`);
    },

    // Names of branches starting with `prefix`.
    async listBranches(prefix) {
      const res = await call(`git/matching-refs/heads/${prefix}`, { cache: 'no-store' });
      if (!res.ok) throw new HttpError(502, `GitHub list failed (${res.status})`);
      return (await res.json()).map((r) => r.ref.replace('refs/heads/', ''));
    },
  };
}
