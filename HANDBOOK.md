# Jiko Technical Handbook & Notes

This document keeps deeper technical notes and implementation details outside `README.md`.

## Architecture Overview

- **Even G2 App (`src/main.ts`):** Uses `@evenrealities/even_hub_sdk` (`waitForEvenAppBridge`, `createStartUpPageContainer`, `textContainerUpgrade`, `audioControl`, `onEvenHubEvent`) to render a single 576x288 text container with four cycling cards (`1/4` Welcome, `2/4` Wallet, `3/4` Notion, `4/4` Instructions), 16 kHz PCM audio capture, and companion pairing UI (`localStorage` token `jiko_token`).
- **Backend API & Telegram Bot (`bot/bot.js`, `bot/api.js`, `bot/core.js`, `bot/notion.js`):** Node.js HTTP server + `grammy` Telegram bot.
- **Persistence (`bot/core.js`):** Uses Postgres (`jiko_kv` table with `registry` and `sessions` JSONB keys) when `DATABASE_URL` is set, with an in-memory write-through cache and local JSON fallback.
- **Notion Integration (`bot/notion.js`):** Dynamically inspects database properties (`title`, optional select/multi-select tag, optional checkbox matching `done|complete|check|status`, optional numeric `Amount` and `USD Ref`, optional `Due` date). Supports creating tasks (`Task`) and notes (`Voice Note`), listing open tasks, marking tasks complete via `PATCH` (with stemming and semantic fallback matching), topic search, and HUD briefings.
- **Pricing & Settlement (`bot/api.js`):** Fetches live TON/USD reference pricing with a 60-second cache across `TonAPI`, `CoinGecko`, and `Kraken`, converts USD/coffee requests into `GRAM` (`Math.max(0.01, Number((usd / tonPrice).toFixed(2)))`), enforces `MAX_TESTNET_GRAM = 25`, and polls `testnet.toncenter.com` for matching outgoing transfers.

## Recipient Matching & Privacy

- `findRecipient` normalizes spoken names and usernames (including leetspeak digit mapping and phonetic normalization) locally on the server and flags ties as ambiguous rather than guessing.
- Only aliases configured via `/voicename` are added to speech/intent hints; `/voicename clear` removes the alias.
- Incoming Telegram replies routed back to `/inbox` are stored and displayed as plain text without passing through LLM summarization or rewriting.