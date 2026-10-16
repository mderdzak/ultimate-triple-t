// Calls to the relay worker, which reads/writes the game folder on GitHub.
import { RELAY_URL } from './config.js?v=7';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  if (RELAY_URL.includes('YOUR-SUBDOMAIN')) {
    throw new ApiError(0, 'The game server is not set up yet: add the worker URL to js/config.js');
  }
  let res;
  try {
    res = await fetch(RELAY_URL + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, "Can't reach the game server. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

export const createGame = (hostName, guestName) => request('POST', '/games', { hostName, guestName });
// `tag` is the `v` from the previous reply: if nothing changed, the reply is just { unchanged: true }.
export const getGame = (code, tag) => request('GET', `/games/${code}${tag ? `?v=${encodeURIComponent(tag)}` : ''}`);
export const sendChat = (code, token, text) => request('POST', `/games/${code}/chat`, { token, text });
export const joinGame = (code) => request('POST', `/games/${code}/join`);
export const sendMove = (code, token, board, cell) => request('POST', `/games/${code}/move`, { token, board, cell });
export const deleteGame = (code, token) => request('DELETE', `/games/${code}`, { token });
