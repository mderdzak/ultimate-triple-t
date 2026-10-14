# Ultimate Triple T

Play Ultimate Tic Tac Toe with a friend in the browser. One player starts a game and gets a 6-digit code, and the other joins with it.

**Play:** https://mderdzak.github.io/ultimate-triple-t/

## How it works

```
 browser ──► relay worker (Cloudflare, holds the GitHub token) ──► this repo, branch game-data
                                                                     games/<code>/state.json
```

- **Start game:** creates `games/<code>/state.json` on the `game-data` branch. The host plays X and moves first.
- **Join game:** the second player enters the code and plays O.
- **Submit move:** the worker checks the move against the rules in `js/game.js` and commits the new board.
- **Waiting:** the waiting player's page checks for the opponent's move every 5 seconds.
- **Game over:** the folder is deleted once the second player sees the result. An hourly cleanup also removes finished games after 1 hour and abandoned ones after 7 days.

Game folders live on the separate `game-data` branch so that each move doesn't trigger a GitHub Pages rebuild of the site on `main`.

The site can't hold a GitHub token itself, because anyone could read it from the page. That's why a small worker sits in the middle.

## One-time setup

1. **Create a GitHub token** at https://github.com/settings/personal-access-tokens/new:
   - Repository access: *Only select repositories* → `ultimate-triple-t`
   - Permissions: *Contents* → **Read and write**
2. **Deploy the worker:**
   ```bash
   cd worker
   npm install
   npx wrangler login              # opens Cloudflare in your browser (free account)
   npx wrangler secret put GITHUB_TOKEN   # paste the token from step 1
   npx wrangler deploy             # prints https://ultimate-triple-t.<you>.workers.dev
   ```
3. **Point the site at the worker:** put the printed URL in `DEPLOYED_RELAY_URL` in `js/config.js`, then commit and push.

## Run locally

```bash
echo "GITHUB_TOKEN=<token from step 1>" > worker/.dev.vars   # gitignored
cd worker && npm run dev          # relay on http://localhost:8787
python3 -m http.server 8000       # in the repo root, then open http://localhost:8000
```

To try both players on one computer, open one tab at `http://localhost:8000` and the other at `http://127.0.0.1:8000`. Each address keeps its own saved game.

## Files

| Path | What it is |
| --- | --- |
| `index.html`, `css/style.css` | The page |
| `js/app.js` | Screens, board UI, submit, polling |
| `js/game.js` | Rules engine, shared by the page and the worker |
| `js/api.js`, `js/config.js` | Calls to the worker, plus the worker URL |
| `worker/` | Cloudflare Worker that reads and writes game files on GitHub |

## Limits

GitHub allows 5,000 API calls an hour per token. A waiting player uses about 720 an hour, so roughly 6 games can run at the same time.
