// Where the relay worker lives (see worker/ and README.md).
// On localhost the site talks to `npm run dev` in worker/; on GitHub Pages it
// talks to the deployed worker. Paste your workers.dev URL below after deploying.
const DEPLOYED_RELAY_URL = 'https://ultimate-triple-t.YOUR-SUBDOMAIN.workers.dev';

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

export const RELAY_URL = isLocal ? 'http://localhost:8787' : DEPLOYED_RELAY_URL;

// How often the waiting player checks for the opponent's move.
export const POLL_INTERVAL_MS = 5000;
