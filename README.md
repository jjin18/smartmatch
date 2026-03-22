# Smart Match

A local web app with a Canva-inspired home experience: browse **Your designs**, **Templates**, and **Smart Match**—a matcher that ranks workspace designs by meaning, keywords, color, and layout. The server can use **Anthropic Claude** for matching when an API key is configured, or fall back to a **local multi-signal scorer** (with optional sentence embeddings via `@xenova/transformers`).

## Requirements

- [Node.js](https://nodejs.org/) 18+ recommended

## Setup

```bash
cd smartmatch
npm install
```

Create a `.env` file in the project root (optional but recommended for Claude-powered matching):

```env
ANTHROPIC_API_KEY=your_key_here
ANTHROPIC_MODEL=claude-3-5-haiku-20241022
PORT=3000
```

If `ANTHROPIC_API_KEY` is omitted, Smart Match uses the local scorer. Do not commit real API keys; keep `.env` private.

## Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) (or the port set in `PORT`).

## Deploy on Vercel

This app is a single **Express** server (`server.mjs`) that also serves static files. Vercel does not run `npm start` for routing unless you wire it up.

- **`vercel.json`** rewrites all paths to the serverless handler **`api/index.mjs`**, which imports the same Express `app` as local dev.
- **`server.mjs`** exports `export default app` and only calls `app.listen()` when you run `node server.mjs` locally.

In the Vercel project settings, add the same variables you would use in `.env` (at minimum **`ANTHROPIC_API_KEY`** and **`ANTHROPIC_MODEL`** if you use Claude). Do not rely on committing `.env`.

**Note:** `@xenova/transformers` / `onnxruntime-node` can be heavy or sensitive to the serverless environment. If match requests fail after deploy, check the function logs; you may need to rely on Claude or the keyword-only path. On **Vercel Pro**, you can add a `functions` entry in `vercel.json` to raise `maxDuration` for `api/index.mjs` if cold-start embedding work hits the default time limit.

## Data

Design metadata and thumbnails are loaded from `data/workspace.json` at startup. Edit or replace that file to change what appears in the UI and what the matcher can rank.

## API (for reference)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Status: assets, LLM, embeddings |
| `GET` | `/api/assets` | List normalized assets |
| `POST` | `/api/match` | Body: `{ "query": "…" }` — ranked matches |
| `POST` | `/api/match-from-asset` | Body: `{ "assetId": "…" }` — matches from a design |

Static files (`index.html`, `app.js`, `styles.css`, `assets/`) are served from the project root.

## License

Private project (`"private": true` in `package.json`).
