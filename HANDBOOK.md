# Jiko Technical Handbook & Notes

This document keeps deeper architectural details, API contracts, data retention rules, and known limitations outside `README.md`.

## Architecture Overview

- **Even G2 App (`src/main.ts`):** Uses `@evenrealities/even_hub_sdk` (`waitForEvenAppBridge`, `createStartUpPageContainer`, `textContainerUpgrade`, `audioControl`, `onEvenHubEvent`) to render a single `576x288` text container with four cycling cards (`1/4` Welcome, `2/4` Wallet, `3/4` Notion, `4/4` Voice Guide), 16 kHz PCM audio capture (`15s` cap), and companion pairing UI (`localStorage` token `jiko_token`).
- **Manifest & Permissions (`app.json`):** Package ID `com.jiko.g2`, `entrypoint: index.html`, `supported_languages: ["en"]`, declaring `g2-microphone` for voice capture. The client defaults to `https://jiko-ob5s.onrender.com` (overridable via `VITE_API_URL`).
- **Backend API & Telegram Bot (`bot/bot.js`, `bot/api.js`, `bot/core.js`, `bot/notion.js`):** Node.js 20+ HTTP server + `grammY` Telegram bot.
- **Persistence (`bot/core.js`):** Uses Postgres (`jiko_kv` table storing two JSONB keys: `registry` and `sessions`) when `DATABASE_URL` is set, with an in-memory write-through cache and local JSON fallback. In production on Render, `DATABASE_URL` is required because local disk resets on restart.
- **Notion Integration (`bot/notion.js`):** Dynamically inspects database properties (`title`, optional `select`/`multi_select` tag, optional checkbox matching `done|complete|check|status`, optional numeric `Amount` and `USD Ref`, optional `Due` date). Task completion uses local word stemming first, with a Groq semantic fallback (`matchTaskWithAi`) when local matching finds no candidate.
- **Pricing & Settlement (`bot/api.js`):** Fetches live TON/USD reference pricing with a 60-second cache across `TonAPI`, `CoinGecko`, and `Kraken`, converts USD/coffee requests into `GRAM` using `Math.max(0.01, Number((usd / tonPrice).toFixed(2)))` (intentional `0.01 GRAM` floor), enforces `MAX_TESTNET_GRAM = 25`, and polls `testnet.toncenter.com` checking timestamp, exact nanotons (`value`), and canonical recipient address (`canonicalAddr`).

## HTTP API Endpoints (`bot/api.js`)

All protected endpoints require a 128-bit random hex session token (`crypto.randomBytes(16)`) in the `x-jiko-token` header. `Access-Control-Allow-Origin: *` is used because authentication relies on this explicit header rather than cookies.

| Method & Path | Auth | Input | Output |
| :--- | :--- | :--- | :--- |
| `GET /health` | No | — | `{ ok, service, db, notion, coffeeUsd }` |
| `POST /pair` | No | `{ code }` (6-digit `/pair` code, 5m TTL) | `{ ok, token, label, wallet, balance }` |
| `POST /cancel` | No | `{ id }` (payment watch ID) | `{ ok: true }` |
| `POST /me` | Token | `{}` | `{ ok, label, wallet, balance }` |
| `POST /unpair` | Token | `{}` | Revokes session token |
| `POST /cards` | Token | `{}` | `{ ok, balance, cards: [c1, c2, c3, c4] }` |
| `POST /inbox` | Token | `{}` | `{ ok, message \| null }` (pops queued Telegram reply) |
| `POST /voice` | Token | Raw 16 kHz PCM (`<= 3 MB`) | `{ text }` (Groq Whisper transcript) |
| `POST /command` | Token | `{ text }` | Action result or pending confirmation `{ id, summary }` |
| `POST /confirm` | Token | `{ id }` | Dispatches confirmed message, invite, request, or tip |
| `POST /status` | Token | `{ id }` | `{ status, amount, label }` |

## Data Retention & Privacy

- **Persistent records (`jiko_kv`):** Linked testnet wallet addresses, opt-in `/voicename` aliases, custom coffee prices, and active glasses session tokens remain stored until the user runs `/unlink` (or `/unpair` for a single glasses session) or `/voicename clear` for aliases.
- **Incoming Telegram replies:** Queued in server memory only until popped by `/inbox` and displayed on the glasses (never persisted to Postgres and never sent to an LLM).
- **Third-party AI scope:** Spoken audio, opt-in `/voicename` aliases, and Notion entry titles/tags (when using summarize, search, or semantic task-match fallback) are sent to Groq. Telegram usernames are excluded from AI prompts.

## Deployment (Render)

- **Root / Service:** `bot/`
- **Build Command:** `npm install`
- **Start Command:** `node bot.js` (Render injects env vars directly)
- **Health Check Path:** `/health` (returns `"db": true` when `DATABASE_URL` is connected)

## Known Limitations

- **Simulator only:** Tested on the Even Hub simulator, not yet on physical Even G2 hardware. Double-tap currently maps to sync/cancel and will be aligned with Even Hub's hardware exit gesture before store submission.
- **In-memory transient state:** Pending confirmations (`pending`), active transaction watches (`watching`), pair codes, and unpopped `/inbox` replies live in RAM and are cleared if the Render process restarts mid-action.
- **Render free-tier cold start:** Without an external `/health` pinger, the free instance sleeps after ~15 minutes of inactivity and takes ~1 minute to wake up.
- **Single-document JSONB storage:** `registry` and `sessions` are stored as two JSONB blobs in `jiko_kv`; concurrent writes at high scale could overwrite each other (acceptable for hackathon demo traffic; row-per-user schema is planned for production).
- **Same-recipient duplicate tips:** Payment watching checks timestamp, exact amount, and canonical recipient address, but two identical-amount tips to the exact same recipient within one 5-minute window could match the same outgoing transaction.
- **Language & input:** Voice commands are currently English-only (`language: "en"`) and tap-to-talk rather than continuous wake-word listening.