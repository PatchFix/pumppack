# PumpFun ToolKit

Node.js app that streams Pump.fun token activity, serves a small web UI, and exposes REST + Socket.IO APIs for alerts, launch watching, and volume rankings.

## Features

- **Dex Alerts** (`public/alerts.html`) — payment / launch monitoring and alert rules with optional user accounts when Postgres is configured.
- **Launch Watch** (`public/watch.html`) — match new tokens against rules (deployer, ticker, name, Twitter, etc.) with live Socket.IO updates.
- **Top Volume** (`public/scout.html`) — top tokens by current 1-minute buy + sell volume (SOL), with chart links (Axiom / GMGN / Terminal).
- **Home** (`public/index.html`) — entry point and navigation.

`public/scout_old.html` is a **deprecated** token browser that predates the simplified 1-minute volume tracker above. It is not linked from the main UI, but the markup and behavior may be a useful starting point if you want to design a **custom watchlist** view.

The backend connects to **PumpPortal** over WebSocket (`wss://pumpportal.fun/api/data`), keeps an in-memory token set, and fans updates to browsers via **Socket.IO**.

### Home page contract address

The home page shows a **contract address** loaded from the server (`GET /api/localToken`). When the backend detects a **new Pump.fun token creation** from the configured launch developer wallet, it stores that mint and the API returns it instead of the `localToken` environment fallback—so the site reflects the latest launch token after you load or refresh the page. (See `launchToken` and `LAUNCH_DEVELOPER_WALLET` in `clank.js`.)

### Telegram

**Telegram alerts are not currently enabled** in day-to-day use. The codebase already includes wiring for a Telegram bot (e.g. bot name / API usage in `clank.js`) so you can turn on or extend bot-triggered notifications if you configure a bot token and finish hooking up the paths you want.

## Requirements

- **Node.js** 20+ recommended.
- **npm** for dependencies.

Optional:

- **PostgreSQL** — set `DATABASE_URL` for persistent user/alert storage; without it the app can fall back to JSON storage where implemented.

## Quick start

```bash
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000) (or the port you set with `PORT`).

## Configuration (environment)

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP server port (default `3000`). |
| `DATABASE_URL` | Postgres connection string when using the database. |
| `SOCKET_IO_CORS_ORIGIN` | Comma-separated origins for Socket.IO CORS, or leave unset for permissive defaults in dev. |
| `localToken` | Fallback mint shown on the home page when no launch token has been detected yet. |
| `TELEGRAM_BOT_API_KEY` | Reserved for future or custom Telegram bot integration; alerts via Telegram are not active by default (see **Telegram** above). |

Pages that talk to a different host (e.g. static front + API on another domain) can use meta tags:

- `public/watch.html` / `public/scout.html`: `api-backend-url`, `socket-backend-url` in `<meta>` tags.

## Realtime API (Socket.IO)

Clients typically subscribe to events such as:

- `tokens:all` — full snapshot.
- `token:new`, `token:update`, `token:remove` — incremental changes.

Exact payloads mirror the in-memory token objects built in `clank.js` (mint, name, symbol, volumes, `tradesPerMinute`, etc.).

## HTTP API (examples)

- `GET /api/localToken` — mint for the home “contract” line (may reflect env or a detected launch).
- `GET /api/pump-coin/:mint` — proxied Pump.fun coin metadata (used by Launch Watch / Scout for images and fields; avoids browser CORS on Pump’s frontend API).

Other routes are defined in `clank.js` (users, alerts, image proxy, etc.).

## Project layout

```
├── clank.js          # Main server: Express, Socket.IO, PumpPortal WebSocket, APIs
├── core.js           # Shared / alternate Solana tooling (used by other flows)
├── public/           # Static UI (HTML, CSS, assets)
└── package.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run `node clank.js`. |

## Disclaimer

This software interacts with live market and social data. It is provided as-is for educational and tooling purposes. Trading carries risk; verify everything on-chain and comply with applicable laws and terms of service for any APIs or sites you use.
