import { playableBoards, isLegalMove, winningLine } from './game.js';
import { POLL_INTERVAL_MS } from './config.js';
import * as api from './api.js';

const SESSION_KEY = 'utt-session';

// Current game, if any.
let session = null;   // { code, token, role }
let state = null;     // public game state from the server
let pending = null;   // { board, cell } selected but not yet submitted
let busy = false;     // a submit is in flight
let pollTimer = null;
let lastChecked = null;

const $ = (sel) => document.querySelector(sel);

// ---------- screens ----------

function show(name) {
  for (const el of document.querySelectorAll('.screen')) {
    el.hidden = el.id !== `screen-${name}`;
  }
}

function goHome() {
  stopPolling();
  session = null;
  state = null;
  pending = null;
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
  saveSession();
  show('game');
  render();
  schedulePolling();
}

function isMyTurn() {
  return state.status === 'active' && state.turn === session.role;
}

function opponentRole() {
  return session.role === 'X' ? 'O' : 'X';
}

// The waiting player checks GitHub (via the relay) every 5 seconds.
// The host also checks while waiting for the opponent to join.
function needsPolling() {
  if (!state) return false;
  if (state.status !== 'active') return false;
  return !isMyTurn() || !state.players.O.joined;
}

function schedulePolling() {
  stopPolling();
  if (needsPolling()) pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

async function poll() {
  pollTimer = null;
  if (!session) return;
  try {
    const { state: s } = await api.getGame(session.code);
    lastChecked = new Date();
    $('#game-error').textContent = '';
    const changed = JSON.stringify(s) !== JSON.stringify(state);
    state = s;
    if (changed) render(); else renderMeta();

    // We watched the game end: we're the last one who needs the folder, so remove it.
    if (state.status === 'finished') {
      api.deleteGame(session.code, session.token).catch(() => {});
      clearSession();
      return;
    }
  } catch (err) {
    if (err.status === 404) {
      $('#status').textContent = 'This game no longer exists.';
      clearSession();
      return;
    }
    $('#game-error').textContent = `${err.message} Retrying…`;
  }
  schedulePolling();
}

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
