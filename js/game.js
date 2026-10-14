// Ultimate Tic Tac Toe rules engine.
// Shared by the website (js/app.js) and the relay worker (worker/src/index.js),
// so both sides agree on what a legal move is.
//
// Boards and cells are numbered 0-8, left to right, top to bottom:
//   0 1 2
//   3 4 5
//   6 7 8

export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];

// Returns 'X' or 'O' if that player has three in a row, otherwise null.
export function lineWinner(cells) {
  for (const [a, b, c] of LINES) {
    if (cells[a] && cells[a] !== 'D' && cells[a] === cells[b] && cells[a] === cells[c]) {
      return cells[a];
    }
  }
  return null;
}

// The winning line (array of 3 indexes) or null.
export function winningLine(cells) {
  for (const line of LINES) {
    const [a, b, c] = line;
    if (cells[a] && cells[a] !== 'D' && cells[a] === cells[b] && cells[a] === cells[c]) {
      return line;
    }
  }
  return null;
}

export function newBoardState() {
  return {
    boards: Array.from({ length: 9 }, () => Array(9).fill(null)),
    // null = still open, 'X' / 'O' = won by that player, 'D' = full with no winner
    boardWinners: Array(9).fill(null),
    // The small board the current player must play in, or null for "any open board".
    nextBoard: null,
    turn: 'X',
    moves: [],
    status: 'active', // 'active' | 'finished'
    winner: null,     // null | 'X' | 'O' | 'draw'
  };
}

// Small boards the current player may play in.
export function playableBoards(state) {
  if (state.status !== 'active') return [];
  if (state.nextBoard !== null && state.boardWinners[state.nextBoard] === null) {
    return [state.nextBoard];
  }
  return state.boardWinners.flatMap((w, i) => (w === null ? [i] : []));
}

export function isLegalMove(state, board, cell) {
  if (!Number.isInteger(board) || !Number.isInteger(cell)) return false;
  if (board < 0 || board > 8 || cell < 0 || cell > 8) return false;
  if (!playableBoards(state).includes(board)) return false;
  return state.boards[board][cell] === null;
}

// Returns a new state with the move applied. Throws on an illegal move.
export function applyMove(state, board, cell) {
  if (!isLegalMove(state, board, cell)) {
    throw new Error('Illegal move');
  }
  const player = state.turn;
  const next = structuredClone(state);

  next.boards[board][cell] = player;
  next.moves.push({ player, board, cell });

  // Did this move decide the small board?
  const small = next.boards[board];
  const smallWinner = lineWinner(small);
  if (smallWinner) {
    next.boardWinners[board] = smallWinner;
  } else if (small.every(Boolean)) {
    next.boardWinners[board] = 'D';
  }

  // Did it decide the whole game?
  const bigWinner = lineWinner(next.boardWinners);
  if (bigWinner) {
    next.status = 'finished';
    next.winner = bigWinner;
  } else if (next.boardWinners.every(Boolean)) {
    next.status = 'finished';
    next.winner = 'draw';
  }

  // The cell played picks the opponent's board. If that board is already
  // won or full, they may play in any open board (nextBoard = null).
  next.nextBoard = next.boardWinners[cell] === null ? cell : null;
  next.turn = player === 'X' ? 'O' : 'X';
  if (next.status === 'finished') next.nextBoard = null;

  return next;
}
