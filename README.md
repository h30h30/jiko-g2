# Jiko — Voice & HUD Companion for Even G2

Jiko is a voice and glanceable HUD app for **Even G2** smart glasses paired with a **Telegram** bot ([@jikopay_bot](https://t.me/jikopay_bot)) and companion web app, connecting **Notion** tasks/notes and a **non-custodial TON Testnet** tip flow.

- **Primary Track:** Track 04 — AI Assistants & Work
- **Secondary Track:** Track 02 — Crypto & DeFi (TON Testnet)
- **Live Companion & Wallet Linker:** [h30h30.github.io/jiko-g2](https://h30h30.github.io/jiko-g2)
- **Backend API & Health:** [jiko-ob5s.onrender.com/health](https://jiko-ob5s.onrender.com/health)
- **Demo Notion Sandbox (read-only view):** [Jiko Log on Notion](https://faint-candytuft-438.notion.site/423cb74eaa9280c4825fda1dd84fbd7b?v=423cb74eaa9280b2804c000c5089cdec)
- **Technical Notes:** [HANDBOOK.md](./HANDBOOK.md)

---

## What It Does Right Now

- **G2 HUD & Controls:** Four swipeable cards (`Welcome`, `Wallet`, `Notion`, `Instructions`), single-tap voice capture (`15s` cap), single-tap confirmation (`8s` window), double-tap sync/cancel, and foreground enter/exit audio cleanup.
- **Notion Task & Note Loop:** Add tasks (`"New task: ..."` / `"Add task: ..."` / `/task`), list open tasks (`"What are my open tasks?"`), mark tasks complete (`"Mark ... as done"` / `/done`), save notes (`"Note: ..."` / `/note`), search entries, request a quick HUD briefing (`"Catch me up"`), and log completed tips with optional `Amount` and `USD Ref` columns.
- **Two-Way Telegram Replies on G2:** Send short messages via voice confirmation (`"Tell Alex ..."`), receive replies directly on the glasses display with **zero LLM processing on incoming messages**, and reply by voice or `/reply`.
- **Non-Custodial TON Testnet Tips:** Connect a **TON Testnet** wallet (`chain: -3`) via Telegram WebApp / TON Connect, reject Mainnet wallets, convert coffee/USD amounts using a live TON/USD reference rate (`TonAPI` with `CoinGecko` and `Kraken` fallbacks), and sign transfers in your wallet while the backend watches Toncenter for on-chain confirmation.

---

## Privacy, Safety & Testnet Scope

- **Testnet only (no real value):** All transfers and balances use TON Testnet (`-3`) with a `25 GRAM` per-action cap. USD figures are reference estimates (`ref`), not guaranteed execution prices.
- **Non-custodial:** Private keys never touch the server. Every payment requires manual wallet approval and expires after 5 minutes.
- **Voice alias opt-in:** Only explicit `/voicename` aliases are included in Groq speech/intent hints; Telegram usernames are not sent to third-party AI services, and `/voicename clear` removes the alias.
- **Demo workspace note:** The hosted deployment uses a shared Notion Sandbox database for quick evaluation; self-hosters connect their own Notion integration and database via environment variables.

---

## Tested vs. Planned

| Area | Status | Notes |
| :--- | :--- | :--- |
| G2 simulator UI, 4 cards, Up/Down/Click/Double-Click & `.ehpk` pack | **Tested** | Built with Vite and packed via `@evenrealities/evenhub-cli` (`jiko-g2.ehpk`). |
| Pairing (`/pair`), `/voicename`, `/coffee`, `/price` & Neon Postgres persistence | **Tested** | Verified against live Render deployment and Neon `jiko_kv` table. |
| Notion add task, list open tasks, mark done (`PATCH`), note, search & briefing | **Tested** | Tested end-to-end against the demo Notion database. |
| Two-way Telegram message send + incoming reply on G2 (no AI on inbound) | **Tested** | Tested with Telegram reply and `/reply` routing. |
| TON Testnet wallet link, Mainnet rejection, coffee/USD conversion & Toncenter watch | **Tested** | Verified Mainnet warning and Testnet transfer flow. |
| Per-user Notion OAuth (`Connect Notion` per Telegram user) | **Planned** | Currently single-workspace via env vars; per-user OAuth is next. |
| Session-key spending limits for hands-free micro-payments | **Planned** | Blocked by standard TON Connect signing without a custom wallet extension. |
| Native Even Hub push notifications & continuous wake-word listening | **Planned** | Currently uses short-interval `/inbox` polling and tap-to-talk. |

---

## Quick Start (5 Minutes)

1. **Install & build the G2 web app:**

   ```bash
   npm install
   npm run build
   ```

   To pack an `.ehpk` bundle:

   ```bash
   npx @evenrealities/evenhub-cli pack app.json dist -o jiko-g2.ehpk
   ```

2. **Configure environment variables (`bot/`):**

   ```bash
   cd bot
   npm install
   cp .env.example .env
   node bot.js
   ```

3. **Link & pair:** Open [@jikopay_bot](https://t.me/jikopay_bot) in Telegram, run `/start` to link a TON Testnet wallet, run `/pair` for a 6-digit code, and enter it in the companion app.

---

## Environment Variables

| Variable | Required | Purpose |
| :--- | :--- | :--- |
| `BOT_TOKEN` | Yes | Telegram Bot API token from `@BotFather`. |
| `GROQ_API_KEY` | Yes | Groq API key for Whisper transcription (`whisper-large-v3-turbo`) and intent/summary routing. |
| `DATABASE_URL` | Recommended | Postgres connection string (e.g., Neon) for persistent users and G2 sessions. |
| `NOTION_API_KEY` | Optional | Notion internal integration token. |
| `NOTION_DATABASE_ID` | Optional | Target Notion database ID or URL. |
| `NOTION_ALLOWED_USERS` | Optional | Comma-separated Telegram IDs or `@usernames` allowed to read/write the shared Notion database. |
| `PUBLIC_API_URL` | Optional | Public backend URL passed to `pay.html` for payment status tracking. |
| `COFFEE_PRICE_USD` | Optional | Default USD reference price per coffee (defaults to `5`). |
| `GROQ_STT_MODEL` | Optional | Speech model override (defaults to `whisper-large-v3-turbo`). |
| `GROQ_LLM_MODEL` | Optional | Chat/intent model override (defaults to `openai/gpt-oss-20b`). |
| `PORT` / `HOST` | Optional | HTTP server bind port and host (defaults to `8787` / `0.0.0.0`). |

---

## Feature Requests for Platform & Ecosystem APIs

1. **Telegram Mini App / WebApp transaction result callback to bot:** Allow `sendData` or a signed webhook callback when a user signs or rejects a TON Connect transaction inside a WebApp opened from an inline button, rather than relying on out-of-band chain polling.
2. **Even Hub SDK user/session identity:** Expose an app-scoped or hardware-bound session identifier in the Even Hub SDK so paired glasses sessions do not depend solely on browser `localStorage` in the companion view.
3. **Configurable system `Menu` handling on Even G2:** Allow HUD apps to handle or customize `Menu` hardware events cleanly instead of losing focus to system navigation unexpectedly.
4. **Push delivery channel to Even G2:** Provide a lightweight event or push mechanism from the companion host to the glasses so incoming Telegram replies appear without periodic `/inbox` polling.
5. **TON Connect session-scoped spending allowances:** Add standard protocol support for time- or amount-bounded session permissions (e.g., via wallet extensions) so small approved allowances can be executed without opening the phone wallet each time.

---

## Hackathon Build & AI Usage Disclosure

- **Timeline:** Built from scratch during the hackathon (no prior codebase existed before November 23, 2026).
- **AI assistance:** AI coding tools (including Whisper/LLM APIs and coding assistants) were used to help draft, debug, and refactor code, prompts, and documentation. All changes were reviewed, integrated, and tested manually against the live stack.