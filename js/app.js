import { playableBoards, isLegalMove, winningLine } from './game.js';
import { POLL_INTERVAL_MS, HIDDEN_POLL_INTERVAL_MS } from './config.js?v=7';
import * as api from './api.js?v=7';

const SESSION_KEY = 'utt-session';
const BASE_TITLE = document.title;
const WIDE_LAYOUT = '(min-width: 1000px)'; // keep in sync with css/style.css

// Current game, if any.
let session = null;   // { code, token, role }
let state = null;     // public game state from the server
let pending = null;   // { board, cell } selected but not yet submitted
let busy = false;     // a submit is in flight
let pollTimer = null;
let polling = false;  // a poll request is in flight
let syncTag = '';     // `v` from the last poll reply, so unchanged polls are cheap
let lastChecked = null;

// Chat
let chat = [];        // messages from the server
let outbox = [];      // messages I've sent that the server hasn't confirmed yet
let unread = 0;       // opponent messages that arrived while the tab was hidden
let localId = 0;

const $ = (sel) => document.querySelector(sel);

// ---------- screens ----------

function show(name) {
  for (const el of document.querySelectorAll('.screen')) {
    el.hidden = el.id !== `screen-${name}`;
  }
  document.querySelector('.app').classList.toggle('in-game', name === 'game');
  // On wide screens the how-to sits open beside the board during a game.
  if (name === 'game' && matchMedia(WIDE_LAYOUT).matches) document.querySelector('.rules').open = true;
}

function goHome() {
  stopPolling();
  session = null;
  state = null;
  pending = null;
  chat = [];
  outbox = [];
  syncTag = '';
  clearSession();
  show('home');
}

// ---------- session storage (survives a page refresh) ----------

function saveSession() {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// ---------- start / join ----------

$('#start-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const button = form.querySelector('[type=submit]');
  $('#start-error').textContent = '';
  button.disabled = true;
  try {
    const { code, token, role, state: s } = await api.createGame(form.hostName.value, form.guestName.value);
    enterGame({ code, token, role }, s);
    form.reset();
  } catch (err) {
    $('#start-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const code = form.code.value.trim();
  const button = form.querySelector('[type=submit]');
  $('#join-error').textContent = '';
  if (!/^\d{6}$/.test(code)) {
    $('#join-error').textContent = 'Enter the 6-digit code you were sent.';
    return;
  }
  button.disabled = true;
  try {
    const { token, role, state: s } = await api.joinGame(code);
    enterGame({ code, token, role }, s);
    form.reset();
  } catch (err) {
    $('#join-error').textContent = err.status === 404 ? 'No game with that code. Check the digits.' : err.message;
  } finally {
    button.disabled = false;
  }
});

$('#join-form').code.addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

$('#go-start').addEventListener('click', () => { show('start'); $('#start-form').hostName.focus(); });
$('#go-join').addEventListener('click', () => { show('join'); $('#join-form').code.focus(); });
$('#home-link').addEventListener('click', () => { if (!session) show('home'); });
for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => show('home'));

$('#leave').addEventListener('click', () => {
  if (state?.status === 'active' && !confirm("Leave this game? You won't be able to rejoin it.")) return;
  goHome();
});

$('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(session.code);
    $('#copy-code').textContent = 'Copied';
    setTimeout(() => { $('#copy-code').textContent = 'Copy'; }, 1500);
  } catch {
    $('#copy-code').textContent = 'Copy failed';
  }
});

// ---------- game ----------

function enterGame(newSession, newState) {
  session = newSession;
  state = newState;
  pending = null;
  chat = [];
  outbox = [];
  syncTag = '';
  saveSession();
  show('game');
  render();
  renderChat();
  schedulePolling(0);
}

function isMyTurn() {
  return state.status === 'active' && state.turn === session.role;
}

function opponentRole() {
  return session.role === 'X' ? 'O' : 'X';
}

// Both players check GitHub (via the relay) every couple of seconds while the game
// is active: the waiting player for the opponent's move (or for them to join), and
// both of them for chat messages.
function needsPolling() {
  if (!state) return false;
  return state.status === 'active';
}

function schedulePolling(delay) {
  stopPolling();
  if (polling || !needsPolling()) return; // an in-flight poll reschedules itself
  const wait = delay ?? (document.hidden ? HIDDEN_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
  pollTimer = setTimeout(poll, wait);
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

// Apply a poll reply: { unchanged } or { state?, chat?, v }.
function applyPoll(res) {
  if (res.unchanged) {
    syncTag = res.v;
    renderMeta();
    return;
  }
  let stateChanged = false;
  if (res.state) {
    // Ignore a reply that is older than what we already have (sent before our own move landed).
    if (res.state.moves.length < state.moves.length) return;
    stateChanged = JSON.stringify(res.state) !== JSON.stringify(state);
    state = res.state;
  }
  if (res.chat) mergeChat(res.chat);
  syncTag = res.v;
  if (stateChanged) render(); else renderMeta();
}

async function poll() {
  pollTimer = null;
  if (!session) return;
  polling = true;
  let keepGoing = true;
  try {
    const res = await api.getGame(session.code, syncTag);
    if (!session) return;
    lastChecked = new Date();
    $('#game-error').textContent = '';
    applyPoll(res);

    // We watched the game end: we're the last one who needs the folder, so remove it.
    if (state.status === 'finished') {
      api.deleteGame(session.code, session.token).catch(() => {});
      clearSession();
      renderChat();
      keepGoing = false;
    }
  } catch (err) {
    if (err.status === 404) {
      $('#status').textContent = 'This game no longer exists.';
      clearSession();
      keepGoing = false;
    } else {
      $('#game-error').textContent = `${err.message} Retrying…`;
    }
  } finally {
    polling = false;
  }
  if (keepGoing) schedulePolling();
}

// Check straight away when the tab comes back into view.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  unread = 0;
  updateTitle();
  if (session) schedulePolling(0);
});

async function submitMove() {
  if (!pending || busy) return;
  busy = true;
  render();
  try {
    const { state: s } = await api.sendMove(session.code, session.token, pending.board, pending.cell);
    state = s;
    pending = null;
    $('#game-error').textContent = '';
    if (state.status === 'finished') {
      // Leave the folder for the opponent to see the result; they delete it.
      clearSession();
    }
  } catch (err) {
    $('#game-error').textContent = err.message;
    // Someone else's change got in first, reload the real state.
    if (err.status === 409) {
      try { state = (await api.getGame(session.code)).state; pending = null; } catch {}
    }
  } finally {
    busy = false;
    render();
    schedulePolling();
  }
}

$('#submit-move').addEventListener('click', submitMove);
$('#clear-move').addEventListener('click', () => { pending = null; render(); });

$('#board').addEventListener('click', (e) => {
  const cellEl = e.target.closest('.cell');
  if (!cellEl || !isMyTurn() || busy) return;
  const board = Number(cellEl.dataset.board);
  const cell = Number(cellEl.dataset.cell);
  if (!isLegalMove(state, board, cell)) return;
  pending = pending && pending.board === board && pending.cell === cell ? null : { board, cell };
  render();
});

// ---------- rendering ----------

function render() {
  if (!state || !session) return;
  const me = session.role;
  const them = opponentRole();
  const myTurn = isMyTurn();

  // Share box: host sees the code until the opponent joins.
  $('#share').hidden = !(me === 'X' && !state.players.O.joined && state.status === 'active');
  $('#share-code').textContent = session.code;
  $('#share-name').textContent = state.players.O.name;

  for (const role of ['X', 'O']) {
    const el = $(`#player-${role}`);
    el.querySelector('.pname').innerHTML = '';
    el.querySelector('.pname').append(state.players[role].name);
    if (role === me) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = ' (you)';
      el.querySelector('.pname').append(you);
    }
    el.classList.toggle('turn', state.status === 'active' && state.turn === role);
  }

  $('#status').textContent = statusText(me, them, myTurn);

  renderBoard(myTurn);

  $('#submit-move').disabled = !pending || busy || !myTurn;
  $('#submit-move').textContent = busy ? 'Submitting…' : 'Submit move';
  $('#clear-move').disabled = !pending || busy;
  document.querySelector('.actions').hidden = state.status !== 'active';
  $('#leave').textContent = state.status === 'active' ? 'Leave game' : 'Back to home';
  updateChatEnabled();

  renderMeta();
}

function statusText(me, them, myTurn) {
  const themName = state.players[them].name;
  if (state.status === 'finished') {
    if (state.winner === 'draw') return "It's a draw. No moves left.";
    return state.winner === me ? 'You win! 🎉' : `${state.players[state.winner].name} wins.`;
  }
  if (myTurn) {
    if (pending) return 'Press Submit to play your move.';
    return state.nextBoard === null ? 'Your turn. Play in any open board.' : 'Your turn. Play in the highlighted board.';
  }
  if (!state.players.O.joined && me === 'X') return `Waiting for ${themName} to join…`;
  return `Waiting for ${themName} to move…`;
}

function renderMeta() {
  const parts = [`Game ${session.code}`];
  if (needsPolling() && lastChecked) {
    parts.push(`checked ${lastChecked.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`);
  }
  $('#meta').textContent = parts.join(' · ');
}

function renderBoard(myTurn) {
  const boardEl = $('#board');
  boardEl.innerHTML = '';
  const playable = myTurn ? playableBoards(state) : [];
  const last = state.moves[state.moves.length - 1];
  const bigLine = winningLine(state.boardWinners) || [];

  for (let b = 0; b < 9; b++) {
    const small = document.createElement('div');
    small.className = 'small-board';
    small.setAttribute('role', 'group');
    small.setAttribute('aria-label', `Board ${b + 1}`);
    if (playable.includes(b) && !busy) small.classList.add('playable');
    if (bigLine.includes(b)) small.classList.add('won-line');

    for (let c = 0; c < 9; c++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.board = b;
      cell.dataset.cell = c;
      const value = state.boards[b][c];
      if (value) {
        cell.textContent = value;
        cell.classList.add(value, 'filled');
        if (last && last.board === b && last.cell === c) cell.classList.add('last');
      } else if (pending && pending.board === b && pending.cell === c) {
        cell.textContent = session.role;
        cell.classList.add(session.role, 'pending');
      }
      const legal = playable.includes(b) && !value && !busy;
      cell.tabIndex = legal ? 0 : -1;
      cell.setAttribute('aria-label', `Board ${b + 1}, square ${c + 1}: ${value || 'empty'}`);
      small.append(cell);
    }

    const owner = state.boardWinners[b];
    if (owner) {
      const overlay = document.createElement('div');
      overlay.className = `board-owner ${owner}`;
      overlay.textContent = owner === 'D' ? 'Draw' : owner;
      small.append(overlay);
    }
    boardEl.append(small);
  }
}

// ---------- chat ----------

function updateTitle() {
  document.title = unread ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE;
}

// `list` is the server's full message list.
function mergeChat(list) {
  const known = chat.length ? chat[chat.length - 1].id : 0;
  const fresh = list.filter((m) => m.id > known && m.from !== session.role);
  chat = list;
  if (fresh.length && document.hidden) {
    unread += fresh.length;
    updateTitle();
  }
  renderChat();
}

function renderChat() {
  const log = $('#chat-log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const previousTop = log.scrollTop;

  // Don't show a sent message twice while its confirmation is still on the way.
  const lastId = chat.length ? chat[chat.length - 1].id : 0;
  const waiting = outbox.filter((o) => !chat.some((m) => m.id > o.afterId && m.from === o.from && m.text === o.text));

  log.innerHTML = '';
  const all = [...chat, ...waiting];
  if (!all.length) {
    const empty = document.createElement('li');
    empty.className = 'chat-empty';
    empty.textContent = 'Say hi to your opponent.';
    log.append(empty);
  }
  for (const m of all) {
    const mine = session && m.from === session.role;
    const li = document.createElement('li');
    li.className = `msg from-${m.from}${mine ? ' mine' : ''}${m.pending ? ' sending' : ''}`;
    const name = document.createElement('div');
    name.className = 'msg-name';
    name.textContent = state ? state.players[m.from].name : m.from;
    const text = document.createElement('p');
    text.className = 'msg-text';
    text.textContent = m.text;
    li.append(name, text);
    log.append(li);
  }
  if (nearBottom || waiting.length || lastId === 0) log.scrollTop = log.scrollHeight;
  else log.scrollTop = previousTop;

  updateChatEnabled();
}

// Chat closes when the game ends.
function updateChatEnabled() {
  const open = Boolean(state && state.status === 'active');
  $('#chat-input').disabled = !open;
  $('#chat-input').placeholder = open ? 'Message…' : 'Game over';
  $('#chat-form button').disabled = !open;
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text || !session || state?.status !== 'active') return;
  input.value = '';
  $('#chat-error').textContent = '';

  const local = {
    id: `local-${++localId}`,
    from: session.role,
    text,
    pending: true,
    afterId: chat.length ? chat[chat.length - 1].id : 0,
  };
  outbox.push(local);
  renderChat();
  try {
    const { chat: list } = await api.sendChat(session.code, session.token, text);
    outbox = outbox.filter((m) => m !== local);
    mergeChat(list);
  } catch (err) {
    outbox = outbox.filter((m) => m !== local);
    input.value = text;
    $('#chat-error').textContent = err.message;
    renderChat();
  }
});

// ---------- startup ----------

async function resume() {
  const saved = loadSession();
  if (!saved?.code || !saved?.token) return show('home');
  try {
    const { state: s } = await api.getGame(saved.code);
    enterGame(saved, s);
  } catch {
    clearSession();
    show('home');
  }
}

// A link like ?join=123456 opens straight to the join form.
const joinParam = new URLSearchParams(location.search).get('join');
if (joinParam && /^\d{6}$/.test(joinParam)) {
  clearSession();
  show('join');
  $('#join-form').code.value = joinParam;
} else {
  resume();
}
