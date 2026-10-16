// Where the relay worker lives (see worker/ and README.md).
// On localhost the site talks to `npm run dev` in worker/; on GitHub Pages it
// talks to the deployed worker. Paste your workers.dev URL below after deploying.
const DEPLOYED_RELAY_URL = 'https://ultimate-triple-t.mderdzak.workers.dev';

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

export const RELAY_URL = isLocal ? 'http://localhost:8787' : DEPLOYED_RELAY_URL;

// How often each player checks for the opponent's move and new chat messages.
// Checks are cheap (GitHub answers "not modified" for free), so this can be short.
export const POLL_INTERVAL_MS = 2000;
// ...and how often while the tab is in the background.
export const HIDDEN_POLL_INTERVAL_MS = 8000;
