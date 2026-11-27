# Jiko — Voice & HUD Companion for Even G2

Jiko is a voice and HUD app for **Even G2** smart glasses paired with a **Telegram** bot ([@jikopay_bot](https://t.me/jikopay_bot)) and companion web app, focused on quick voice capture, short replies, and small tips without pulling out your phone for every step.

- **Demo Video (3 min live walkthrough):** [Watch Jiko Demo on YouTube](https://youtu.be/61ZwWRfrC8E)
- **Primary Track:** Track 04 — AI Assistants & Work
- **Secondary Track:** Track 02 — Crypto & DeFi (TON Testnet)
- **Also Entering:** Best Telegram Integration (bot, Mini App wallet linking, pairing, and two-way replies on G2)
- **Live Companion & Wallet Linker:** [h30h30.github.io/jiko-g2](https://h30h30.github.io/jiko-g2)
- **Backend API & Health:** [jiko-ob5s.onrender.com/health](https://jiko-ob5s.onrender.com/health) *(free Render instance: open `/health` first and wait ~1 minute if it is asleep)*
- **Demo Notion Sandbox (public read-only view):** [Jiko Log on Notion](https://faint-candytuft-438.notion.site/423cb74eaa9280c4825fda1dd84fbd7b?v=423cb74eaa9280b2804c000c5089cdec) *(demo data only — public page may need a refresh to show new API updates)*
- **Packaged App Bundle:** [jiko-g2.ehpk](./jiko-g2.ehpk)
- **Technical Notes:** [HANDBOOK.md](./HANDBOOK.md)

---

## What It Does Right Now

- **G2 HUD & Controls:** Four swipeable cards (`Welcome`, `Wallet`, `Notion`, `Voice Guide`), single-tap voice capture (`15s` cap), single-tap confirmation (`8s` window), double-tap sync/cancel, and foreground enter/exit audio cleanup.
- **Notion Task & Note Loop:** Add tasks (`"New task: ..."` / `/task`), save voice notes (`"Note: ..."` / `/note`), list open tasks (`"What are my open tasks?"`), mark tasks done live via `PATCH` (`"Mark ... as done"` / `/done`), search entries, request a 4-line HUD briefing (`"Catch me up"`), and log completed tips with `Amount` and `USD Ref` columns.
- **Two-Way Telegram Replies on G2:** Send messages by voice with single-tap confirmation (`"Tell Alex ..."` or `"Answer Alex ..."`), see incoming replies directly on the glasses display with **zero LLM processing on incoming messages**, and reply by voice or `/reply`.
- **Non-Custodial TON Testnet Tips:** Connect a **TON Testnet** wallet (`chain: -3`) via Telegram WebApp / TON Connect (Mainnet wallets are rejected), send simple tips or customizable-price coffee tips using a live TON/USD reference rate (`TonAPI` with `CoinGecko` and `Kraken` fallbacks), and sign manually in your wallet while the backend watches Toncenter for confirmation.

---

## Who It's For & Path to Launch

- **Who it's for:** Telegram-native TON users and Notion-based builders or teams who want fast voice capture, task check-offs, quick replies, and small tips on smart glasses.
- **Path to launch:** Already packed as `jiko-g2.ehpk` for Even Hub review. Next steps before public release: per-user Notion OAuth (`Connect Notion` per Telegram account), physical G2 hardware testing (including aligning double-tap exit conventions), optional Mainnet mode with strict confirmation guardrails, and always-on production hosting.

---

## Privacy, Safety & Testnet Scope

- **Testnet only (no real value):** All transfers and balances run on TON Testnet (`-3`) with a `25 GRAM` per-action cap. USD amounts are reference estimates (`ref`), not guaranteed execution prices.
- **Non-custodial:** Private keys never touch the server. Every transfer requires manual wallet signing and expires after 5 minutes.
- **What goes to Groq AI vs. what does not:**
  - Speech audio, explicit opt-in `/voicename` aliases, and Notion task/note content (for summaries, search, and semantic task matching) are sent to Groq APIs.
  - Telegram usernames are not sent to Groq, `/voicename clear` removes your alias, and **incoming Telegram replies are never sent to any LLM**.
- **Public demo Notion sandbox:** The hosted demo connects to a shared public Notion database so judges can test immediately without setup. Do not put private information into the demo workspace; self-hosters connect their own Notion database via environment variables.

---

## Tested vs. Planned

> **Hardware note:** Tested on the **Even Hub simulator** and live backend/Telegram/Notion/TON Testnet stack; not yet tested on physical G2 hardware.

| Area | Status | Notes |
| :--- | :--- | :--- |
| G2 simulator UI, 4 cards, Up/Down/Click/Double-Click & `.ehpk` pack | **Tested** | Built with Vite and packed via `@evenrealities/evenhub-cli` (`jiko-g2.ehpk`). |
| Pairing (`/pair`), `/voicename`, `/coffee`, `/price` & Neon Postgres persistence | **Tested** | Verified against live Render deployment and Neon `jiko_kv` table. |
| Notion add task, voice note, list open tasks, mark done (`PATCH`), search & briefing | **Tested** | Tested end-to-end against the live Notion sandbox database. |
| Two-way Telegram send (`Tell`/`Answer`) + incoming reply on G2 (no AI on inbound) | **Tested** | Verified with live Telegram reply and `/reply` routing. |
| TON Testnet wallet link, Mainnet rejection, coffee/USD conversion & Toncenter watch | **Tested** | Verified Mainnet block warning and Testnet transfer confirmation. |
| Physical Even G2 hardware testing & native exit-gesture alignment | **Planned** | Currently validated on simulator only. |
| Per-user Notion OAuth (`Connect Notion` per Telegram user) | **Planned** | Currently single-workspace via env vars; per-user OAuth is next. |
| Session-key spending limits for hands-free micro-payments | **Planned** | Requires wallet-side session allowance support beyond standard TON Connect. |
| Native Even Hub push notifications & continuous wake-word listening | **Planned** | Currently uses 4-second `/inbox` polling and tap-to-talk. |

---

## Quick Start (Node 20+)

1. **Run the G2 app locally in the Even Hub simulator:**

   ```bash
   npm install
   npm run dev
   ```

   In a second terminal, launch the simulator against the Vite dev server (by default it calls `https://jiko-ob5s.onrender.com`; set `VITE_API_URL=http://127.0.0.1:8787` to point to a local backend):

   ```bash
   evenhub-simulator http://localhost:5173
   ```

   To build and pack the `.ehpk` bundle:

   ```bash
   npm run build
   npx @evenrealities/evenhub-cli pack app.json dist -o jiko-g2.ehpk
   ```

2. **Run the Telegram bot & backend (`bot/`):**

   ```bash
   cd bot
   npm install
   cp .env.example .env
   # Fill BOT_TOKEN and GROQ_API_KEY (plus optional DATABASE_URL / NOTION_* vars)
   node --env-file=.env bot.js
   ```

3. **Link & pair:** Open [@jikopay_bot](https://t.me/jikopay_bot) in Telegram, run `/start` to connect a TON Testnet wallet, optionally set `/voicename <name>`, run `/pair` for a 6-digit code, and enter it in the companion view.

---

## Environment Variables

| Variable | Required | Purpose |
| :--- | :--- | :--- |
| `BOT_TOKEN` | Yes | Telegram Bot API token from `@BotFather`. |
| `GROQ_API_KEY` | Yes | Groq API key for Whisper transcription (`whisper-large-v3-turbo`) and intent/Notion routing. |
| `DATABASE_URL` | Recommended | Postgres connection string (e.g., Neon) for persistent users and G2 sessions. |
| `NOTION_API_KEY` | Optional | Notion internal integration token. |
| `NOTION_DATABASE_ID` | Optional | Target Notion database ID or URL. |
| `NOTION_ALLOWED_USERS` | Optional | Comma-separated Telegram IDs or `@usernames` allowed to read/write the Notion database. |
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

- **What existed before Nov 23, 2026:** The official Even Hub minimal template and SDK (`@evenrealities/even_hub_sdk`, `@evenrealities/evenhub-cli`), plus open-source libraries (`grammY`, `TON Connect UI`, `pg`, `Vite`). Everything else in this repository was written between November 23 and November 29, 2026.
- **AI assistance:** AI coding assistants and Groq APIs were used to help draft, debug, and refactor code, prompts, and documentation. All changes were reviewed, integrated, and tested manually against the live stack.