import http from "node:http";
import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import {
  parseCommand,
  findRecipient,
  payLink,
  load,
  loadSessions,
  saveSessions,
  short,
  canonicalAddr,
  createInviteDraft,
  getBotUsername,
} from "./core.js";
import {
  isNotionEnabled,
  saveNotionEntry,
  fetchNotionEntriesData,
  fetchRecentNotionEntries,
} from "./notion.js";

const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";
const GROQ_LLM_MODEL = process.env.GROQ_LLM_MODEL || "openai/gpt-oss-20b";
const TONCENTER_TX = "https://testnet.toncenter.com/api/v2/getTransactions";
const TONCENTER_BAL = "https://testnet.toncenter.com/api/v2/getAddressBalance";
const pending = new Map();
const watching = new Map();
const pairCodes = new Map();

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-jiko-token");
}

function getAuthUserId(req) {
  const token = req.headers["x-jiko-token"];
  if (!token || typeof token !== "string") return null;
  const sessions = loadSessions();
  return sessions[token] ?? null;
}

function userLabel(u) {
  if (!u) return "user";
  return u.username ? "@" + u.username : u.first_name || "user";
}

function timeAgo(utime) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(utime || 0));
  if (diff < 60) return "now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function wavFromPcm(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function transcribe(pcm) {
  if (!process.env.GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");
  const t0 = Date.now();
  const wav = wavFromPcm(pcm);

  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("model", GROQ_STT_MODEL);
  form.append("temperature", "0");
  form.append("language", "en");
  form.append("response_format", "json");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.GROQ_API_KEY,
    },
    body: form,
  });

  if (!res.ok) throw new Error("Groq STT " + res.status + ": " + (await res.text()).slice(0, 200));
  const json = await res.json();
  const text = (json.text ?? "").trim();
  console.log(
    `[TIMING] Groq Whisper STT: ${((Date.now() - t0) / 1000).toFixed(2)}s (${(pcm.length / 32000).toFixed(1)}s audio)`
  );
  return text;
}

async function understandVoice(transcript) {
  if (!process.env.GROQ_API_KEY) return parseCommand(transcript);
  const t0 = Date.now();

  const systemPrompt =
    "You are Jiko, a smart voice assistant on Even G2 smart glasses connected to a TON crypto tip wallet and Notion workspace.\n" +
    "Classify the user's spoken input into ONE JSON object (raw JSON only):\n" +
    '1) Sending money/tip: {"type":"tip","amount":<number>,"name":"<recipient name>"}\n' +
    '2) Requesting money from someone: {"type":"ask","amount":<number>,"name":"<payer name>"}\n' +
    '3) Checking wallet balance: {"type":"balance"}\n' +
    '4) Checking recent TON transactions/activity: {"type":"history"}\n' +
    '5) Saving a voice note, reminder, memo, or task to Notion: {"type":"note","content":"<clean note text>"}\n' +
    '6) Simply listing/showing the latest Notion notes: {"type":"notes"}\n' +
    '7) Summarizing, analyzing, or asking questions about Notion notes, tasks, or total spending/tips logged: {"type":"notion_summary","question":"<user question>"}\n' +
    '8) Any general question, math calculation, translation, crypto concept, or assistant query: {"type":"answer","reply":"<ultra-concise answer>"}\n' +
    "Rules for 'answer': max 3 short lines (under 110 characters total), plain text only, no emojis or markdown. " +
    "IMPORTANT: Never guess or invent live real-time crypto prices, stock prices, or current weather; if asked for live market prices or current weather, briefly say live data is not connected yet.";

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: GROQ_LLM_MODEL,
        temperature: 0.2,
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: transcript },
        ],
      }),
    });
    if (!res.ok) throw new Error("Groq LLM " + res.status + ": " + (await res.text()).slice(0, 150));
    const json = await res.json();
    const raw = (json.choices?.[0]?.message?.content ?? "").trim();
    const parsed = JSON.parse(raw);
    console.log(`[TIMING] Groq AI intent (${parsed.type}): ${((Date.now() - t0) / 1000).toFixed(2)}s`);

    if (parsed.type === "tip" && Number(parsed.amount) > 0 && parsed.name) {
      return { type: "tip", amount: Number(parsed.amount), name: String(parsed.name).trim() };
    }
    if (parsed.type === "ask" && Number(parsed.amount) > 0 && parsed.name) {
      return { type: "ask", amount: Number(parsed.amount), name: String(parsed.name).trim() };
    }
    if (parsed.type === "note" && parsed.content) {
      return { type: "note", content: String(parsed.content).trim() };
    }
    if (parsed.type === "notion_summary") {
      return { type: "notion_summary", question: String(parsed.question || transcript).trim() };
    }
    if (parsed.type === "balance" || parsed.type === "history" || parsed.type === "notes") {
      return { type: parsed.type };
    }
    if (parsed.type === "answer" && parsed.reply) {
      return { type: "answer", reply: String(parsed.reply).trim().slice(0, 140) };
    }
  } catch (e) {
    console.error("AI ROUTER FALLBACK:", e.message);
  }

  return parseCommand(transcript);
}

// Feature 1: Smart AI analysis & spending summary from Notion workspace
async function summarizeNotion(question) {
  const entries = await fetchNotionEntriesData(25);
  if (!entries.length) return "Notion log is empty.";

  let tipCount = 0;
  let totalGram = 0;
  let noteCount = 0;

  for (const e of entries) {
    const m = e.title.match(/^tip:\s*(\d+(?:\.\d+)?)\s*gram/i);
    if (m || /crypto tip/i.test(e.tag)) {
      tipCount++;
      if (m) totalGram += Number(m[1]);
    } else {
      noteCount++;
    }
  }

  const fallback =
    `Notion summary:\nTips: ${tipCount} (${totalGram.toFixed(2)} GRAM)\nNotes: ${noteCount}`;

  if (!process.env.GROQ_API_KEY) return fallback;

  const t0 = Date.now();
  const listText = entries
    .map((e, i) => `${i + 1}. [${e.tag || "Entry"} | ${e.date}] ${e.title}`)
    .join("\n");

  const prompt =
    "You are Jiko on Even G2 smart glasses. Answer the user's question using ONLY the Notion workspace entries and exact pre-calculated stats below.\n" +
    "Format rules: max 4 short lines (under 140 characters total), plain text only, no markdown, no emojis, no invented facts.\n\n" +
    `Exact stats: ${tipCount} tips totaling ${totalGram.toFixed(2)} GRAM; ${noteCount} notes.\n` +
    `Entries (newest first):\n${listText}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: GROQ_LLM_MODEL,
        temperature: 0.2,
        max_tokens: 1024,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: question || "Summarize my Notion notes and spending" },
        ],
      }),
    });
    if (!res.ok) throw new Error("Groq Notion AI " + res.status);
    const json = await res.json();
    const replyText = (json.choices?.[0]?.message?.content ?? "").trim();
    console.log(`[TIMING] Groq Notion summary: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    return replyText ? replyText.slice(0, 160) : fallback;
  } catch (e) {
    console.error("NOTION SUMMARY FALLBACK:", e.message);
    return fallback;
  }
}

async function fetchBalance(address) {
  const t0 = Date.now();
  const r = await fetch(TONCENTER_BAL + "?address=" + encodeURIComponent(address));
  if (!r.ok) throw new Error("Toncenter " + r.status);
  const json = await r.json();
  if (!json.ok) throw new Error(json.error || "Toncenter error");
  console.log(`[TIMING] Toncenter balance: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
  return (Number(json.result) / 1e9).toFixed(2);
}

async function fetchHistory(address) {
  const t0 = Date.now();
  const r = await fetch(TONCENTER_TX + "?address=" + encodeURIComponent(address) + "&limit=6");
  if (!r.ok) throw new Error("Toncenter " + r.status);
  const json = await r.json();
  if (!json.ok || !Array.isArray(json.result)) throw new Error(json.error || "Toncenter error");
  console.log(`[TIMING] Toncenter history: ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  const lines = [];
  for (const tx of json.result) {
    const out = (tx.out_msgs ?? []).find((m) => Number(m.value) > 0);
    if (out) {
      const amt = (Number(out.value) / 1e9).toFixed(2);
      lines.push("-" + amt + " GRAM  (" + timeAgo(tx.utime) + ")");
    } else if (tx.in_msg && Number(tx.in_msg.value) > 0) {
      const amt = (Number(tx.in_msg.value) / 1e9).toFixed(2);
      lines.push("+" + amt + " GRAM  (" + timeAgo(tx.utime) + ")");
    }
    if (lines.length >= 3) break;
  }

  if (!lines.length) return "No recent activity\n(testnet)";
  return "Recent activity:\n" + lines.join("\n");
}

// Feature 5: Build 3 glanceable cards for Even G2 Up/Down navigation
async function buildCards(address) {
  const [balRes, histRes, notionRes] = await Promise.allSettled([
    fetchBalance(address),
    fetchHistory(address),
    isNotionEnabled() ? fetchRecentNotionEntries(3) : Promise.resolve("__DISABLED__"),
  ]);

  const bal = balRes.status === "fulfilled" ? balRes.value : null;
  const card1 =
    "Jiko · 1/3 Wallet\n" +
    "Balance: " + (bal ?? "--") + " GRAM\n" +
    short(address) + " (testnet)";

  let card2 = "Activity · 2/3\nCould not load activity";
  if (histRes.status === "fulfilled") {
    const body = histRes.value.replace(/^Recent activity:\n?/i, "");
    card2 = "Activity · 2/3\n" + body;
  }

  let card3 = "Notion · 3/3\nCould not load notes";
  if (notionRes.status === "fulfilled") {
    if (notionRes.value === "__DISABLED__") {
      card3 = "Notion · 3/3\nNot connected";
    } else {
      const body = notionRes.value.replace(/^Notion log:\n?/i, "");
      card3 = "Notion · 3/3\n" + body;
    }
  }

  return { balance: bal, cards: [card1, card2, card3] };
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const reply = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

async function notify(bot, w, text) {
  try {
    if (w.messageId) await bot.api.editMessageText(w.senderId, w.messageId, text);
    else await bot.api.sendMessage(w.senderId, text);
  } catch {
    await bot.api.sendMessage(w.senderId, text).catch(() => {});
  }
}

async function checkWatches(bot) {
  for (const [id, w] of watching) {
    if (Date.now() - w.since > 600_000) {
      watching.delete(id);
      continue;
    }
    if (w.status !== "waiting") continue;
    if (Date.now() - w.since > 330_000) {
      w.status = "expired";
      await notify(
        bot,
        w,
        "⌛ Not completed: no transaction was seen. It was cancelled, rejected or not signed in time."
      );
      continue;
    }
    try {
      const r = await fetch(TONCENTER_TX + "?address=" + encodeURIComponent(w.senderAddr) + "&limit=10");
      if (!r.ok) continue;
      const json = await r.json();
      if (!json.ok || !Array.isArray(json.result)) continue;
      const targetCanon = canonicalAddr(w.recipientAddr);
      const found = json.result.some(
        (tx) =>
          tx.utime >= Math.floor(w.since / 1000) - 5 &&
          (tx.out_msgs ?? []).some(
            (m) =>
              String(m.value) === w.nano &&
              (!targetCanon || canonicalAddr(m.destination) === targetCanon)
          )
      );
      if (!found) continue;
      w.status = "sent";

      let notionSuffix = "";
      if (isNotionEnabled()) {
        try {
          await saveNotionEntry({
            kind: "tip",
            title: `Tip: ${w.amount} GRAM -> ${w.label}`,
            details: `From ${w.senderLabel} to ${w.label} · ${w.amount} GRAM (TON Testnet) · Logged automatically by Jiko`,
          });
          notionSuffix = "\n📒 Logged to Notion.";
        } catch (e) {
          console.error("NOTION LOG ERROR:", e.message);
        }
      }

      await notify(bot, w, "✅ Sent " + w.amount + " GRAM to " + w.label + " (testnet)." + notionSuffix);
      if (w.recipientId && String(w.recipientId) !== String(w.senderId)) {
        await bot.api
          .sendMessage(
            w.recipientId,
            "💸 You received " + w.amount + " GRAM from " + w.senderLabel + " (testnet)."
          )
          .catch(() => {});
      }
    } catch (e) {
      console.error("WATCH ERROR:", e.message);
    }
  }
}

export function createPairCode(userId) {
  const now = Date.now();
  for (const [k, v] of pairCodes) {
    if (now > v.exp) pairCodes.delete(k);
  }
  const code = String(crypto.randomInt(100000, 1000000));
  pairCodes.set(code, { userId: String(userId), exp: now + 300_000 });
  return code;
}

export function watchPayment(w, customId) {
  const id = customId || crypto.randomBytes(8).toString("hex");
  watching.set(id, { ...w, since: Date.now(), status: "waiting" });
  return id;
}

export function startApi(bot, port = Number(process.env.PORT) || 8787) {
  const host = process.env.HOST || "0.0.0.0";
  setInterval(() => checkWatches(bot), 4000);

  http
    .createServer(async (req, res) => {
      cors(res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        return reply(res, 200, { ok: true, service: "jiko", notion: isNotionEnabled() });
      }
      if (req.method !== "POST") {
        res.writeHead(404);
        return res.end();
      }
      try {
        if (req.url === "/cancel") {
          const { id } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
          const w = watching.get(id);
          if (w && w.status === "waiting") {
            w.status = "cancelled";
            await notify(bot, w, "❌ Payment cancelled in wallet.");
          }
          return reply(res, 200, { ok: true });
        }

        if (req.url === "/pair") {
          const { code } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
          const clean = String(code ?? "").replace(/\s+/g, "");
          const entry = pairCodes.get(clean);
          if (!entry || Date.now() > entry.exp) {
            pairCodes.delete(clean);
            return reply(res, 200, { ok: false, message: "Invalid or expired code. Send /pair in Telegram." });
          }
          pairCodes.delete(clean);
          const me = load()[entry.userId];
          if (!me?.address) {
            return reply(res, 200, { ok: false, message: "Wallet not linked. Send /start in Telegram first." });
          }
          const token = crypto.randomBytes(16).toString("hex");
          const sessions = loadSessions();
          sessions[token] = entry.userId;
          saveSessions(sessions);
          const balance = await fetchBalance(me.address).catch(() => null);
          return reply(res, 200, {
            ok: true,
            token,
            label: userLabel(me),
            wallet: short(me.address),
            balance,
          });
        }

        if (req.url === "/me") {
          const senderId = getAuthUserId(req);
          if (!senderId) return reply(res, 401, { ok: false, error: "Not paired" });
          const me = load()[senderId];
          if (!me?.address) return reply(res, 401, { ok: false, error: "Wallet unlinked" });
          const balance = await fetchBalance(me.address).catch(() => null);
          return reply(res, 200, {
            ok: true,
            label: userLabel(me),
            wallet: short(me.address),
            balance,
          });
        }

        if (req.url === "/unpair") {
          const token = req.headers["x-jiko-token"];
          if (token && typeof token === "string") {
            const sessions = loadSessions();
            if (sessions[token]) {
              delete sessions[token];
              saveSessions(sessions);
            }
          }
          return reply(res, 200, { ok: true });
        }

        const senderId = getAuthUserId(req);
        if (!senderId) {
          return reply(res, 401, { ok: false, error: "Not paired" });
        }

        if (req.url === "/cards") {
          const me = load()[senderId];
          if (!me?.address) return reply(res, 401, { ok: false, error: "Wallet unlinked" });
          const data = await buildCards(me.address);
          return reply(res, 200, { ok: true, ...data });
        }

        if (req.url === "/voice") {
          const pcm = await readBody(req, 3_000_000);
          return reply(res, 200, { text: await transcribe(pcm) });
        }

        if (req.url === "/command") {
          const { text } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
          const cmd = await understandVoice(text ?? "");
          if (!cmd) {
            return reply(res, 200, {
              ok: false,
              message: "Didn't get that.\nTry: send 1 gram to Alex,\nnote: call Ali, or ask anything",
            });
          }

          // Save voice note directly to Notion
          if (cmd.type === "note") {
            if (!isNotionEnabled()) {
              return reply(res, 200, {
                ok: false,
                message: "Notion not configured.\nSet NOTION_API_KEY &\nNOTION_DATABASE_ID",
              });
            }
            try {
              const me = load()[senderId];
              await saveNotionEntry({
                kind: "note",
                title: cmd.content,
                details: `Voice note by ${userLabel(me)} via Even G2 glasses`,
              });
              const preview = cmd.content.length > 60 ? cmd.content.slice(0, 57) + "..." : cmd.content;
              return reply(res, 200, {
                ok: true,
                type: "answer",
                refreshCards: true,
                message: "Saved to Notion:\n" + preview,
              });
            } catch (e) {
              console.error("NOTION NOTE ERROR:", e.message);
              return reply(res, 200, {
                ok: false,
                message: "Could not save to Notion.\nCheck database connection.",
              });
            }
          }

          // Smart AI summary / spending analysis of Notion log
          if (cmd.type === "notion_summary") {
            if (!isNotionEnabled()) {
              return reply(res, 200, {
                ok: false,
                message: "Notion not configured.\nSet NOTION_API_KEY &\nNOTION_DATABASE_ID",
              });
            }
            try {
              const msg = await summarizeNotion(cmd.question);
              return reply(res, 200, {
                ok: true,
                type: "answer",
                message: msg,
              });
            } catch (e) {
              console.error("NOTION SUMMARY ERROR:", e.message);
              return reply(res, 200, {
                ok: false,
                message: "Could not analyze Notion.\nTry again.",
              });
            }
          }

          // Read recent Notion notes
          if (cmd.type === "notes") {
            if (!isNotionEnabled()) {
              return reply(res, 200, {
                ok: false,
                message: "Notion not configured.\nSet NOTION_API_KEY &\nNOTION_DATABASE_ID",
              });
            }
            try {
              const msg = await fetchRecentNotionEntries(3);
              return reply(res, 200, {
                ok: true,
                type: "answer",
                message: msg,
              });
            } catch (e) {
              console.error("NOTION READ ERROR:", e.message);
              return reply(res, 200, {
                ok: false,
                message: "Could not read Notion.\nTry again.",
              });
            }
          }

          // General AI Assistant answer
          if (cmd.type === "answer") {
            return reply(res, 200, {
              ok: true,
              type: "answer",
              message: cmd.reply,
            });
          }

          // Balance check
          if (cmd.type === "balance") {
            const me = load()[senderId];
            if (!me?.address) {
              return reply(res, 200, {
                ok: false,
                message: "No wallet linked.\nOpen Jiko bot and press /start",
              });
            }
            try {
              const bal = await fetchBalance(me.address);
              return reply(res, 200, {
                ok: true,
                type: "balance",
                balance: bal,
                refreshCards: true,
                message: "Balance: " + bal + " GRAM\nWallet: " + short(me.address) + "\n(testnet)",
              });
            } catch (e) {
              console.error("BALANCE ERROR:", e.message);
              return reply(res, 200, {
                ok: false,
                message: "Could not read balance.\nTry again.",
              });
            }
          }

          // Recent transactions
          if (cmd.type === "history") {
            const me = load()[senderId];
            if (!me?.address) {
              return reply(res, 200, {
                ok: false,
                message: "No wallet linked.\nOpen Jiko bot and press /start",
              });
            }
            try {
              const msg = await fetchHistory(me.address);
              return reply(res, 200, {
                ok: true,
                type: "history",
                refreshCards: true,
                message: msg,
              });
            } catch (e) {
              console.error("HISTORY ERROR:", e.message);
              return reply(res, 200, {
                ok: false,
                message: "Could not read history.\nTry again.",
              });
            }
          }

          // Payment request
          if (cmd.type === "ask") {
            if (cmd.amount > 10) return reply(res, 200, { ok: false, message: "Max 10 GRAM (testnet)" });
            const payer = findRecipient(cmd.name);
            if (payer?.ambiguous) {
              return reply(res, 200, {
                ok: false,
                message: 'Several matches for\n"' + cmd.name + '".\nSay the voice name.',
              });
            }
            if (!payer) {
              return reply(res, 200, { ok: false, message: 'No linked wallet for\n"' + cmd.name + '"' });
            }
            const id = crypto.randomBytes(8).toString("hex");
            const label = payer.username ? "@" + payer.username : payer.first_name || cmd.name;
            pending.set(id, { kind: "ask", senderId, payer, amount: cmd.amount, label, at: Date.now() });
            return reply(res, 200, {
              ok: true,
              type: "ask",
              id,
              summary: "Ask " + label + " for\n" + cmd.amount + " GRAM?",
            });
          }

          // Tip command
          if (cmd.amount > 10) return reply(res, 200, { ok: false, message: "Max 10 GRAM (testnet)" });
          const user = findRecipient(cmd.name);
          if (user?.ambiguous) {
            return reply(res, 200, {
              ok: false,
              message: 'Several matches for\n"' + cmd.name + '".\nSay the voice name.',
            });
          }

          if (!user) {
            const id = crypto.randomBytes(8).toString("hex");
            pending.set(id, {
              kind: "invite",
              senderId,
              targetName: cmd.name,
              amount: cmd.amount,
              at: Date.now(),
            });
            return reply(res, 200, {
              ok: true,
              type: "invite",
              id,
              summary: 'No wallet for "' + cmd.name + '".\nSend invite (' + cmd.amount + " GRAM)?",
            });
          }

          const id = crypto.randomBytes(8).toString("hex");
          const label = user.username ? "@" + user.username : user.first_name || cmd.name;
          pending.set(id, { kind: "tip", senderId, user, amount: cmd.amount, label, at: Date.now() });
          return reply(res, 200, {
            ok: true,
            type: "tip",
            id,
            summary: "Send " + cmd.amount + " GRAM to\n" + label + "?",
          });
        }

        if (req.url === "/confirm") {
          const { id } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
          const p = pending.get(id);
          pending.delete(id);
          if (!p || p.senderId !== senderId || Date.now() - p.at > 60_000) {
            return reply(res, 200, { ok: false, message: "Expired" });
          }

          if (p.kind === "invite") {
            const cleanName = p.targetName.toLowerCase().replace(/^@/, "").replace(/\s+/g, "");
            const draftId = createInviteDraft(senderId, cleanName, p.amount);
            await bot.api.sendMessage(
              senderId,
              "@" + cleanName + " hasn't linked a wallet yet.\n" +
                "Ask them to open https://t.me/" + getBotUsername() + " and press /start.\n\n" +
                "No funds move yet — tap below to get notified as soon as they join.",
              {
                reply_markup: new InlineKeyboard().text(
                  "🔔 Notify me when @" + cleanName + " links (24h)",
                  "wait:" + draftId
                ),
              }
            );
            return reply(res, 200, {
              ok: true,
              type: "invite",
              message: "Invite ready in Telegram!\nCheck Jiko bot for @" + cleanName,
            });
          }

          if (p.kind === "ask") {
            const me = load()[senderId];
            if (!me?.address) {
              return reply(res, 200, { ok: false, message: "Link your wallet first" });
            }
            const requesterLabel = userLabel(me);
            const sentToPayer = await bot.api
              .sendMessage(
                p.payer.id,
                "💸 " + requesterLabel + " requested " + p.amount + " GRAM from you (testnet).\nValid for 5 minutes.",
                {
                  reply_markup: new InlineKeyboard().webApp(
                    "Review & sign",
                    payLink({ ...me, id: senderId }, p.amount, id)
                  ),
                }
              )
              .catch(() => null);

            if (!sentToPayer) {
              return reply(res, 200, { ok: false, message: "Could not reach " + p.label });
            }

            if (p.payer.address) {
              watching.set(id, {
                senderAddr: p.payer.address,
                senderId: p.payer.id,
                senderLabel: p.label,
                recipientId: senderId,
                recipientAddr: me.address,
                nano: String(Math.round(p.amount * 1e9)),
                amount: p.amount,
                label: requesterLabel,
                messageId: sentToPayer.message_id,
                since: Date.now(),
                status: "waiting",
              });
            }

            await bot.api
              .sendMessage(senderId, "📩 Sent payment request (" + p.amount + " GRAM) to " + p.label + ".")
              .catch(() => {});

            return reply(res, 200, {
              ok: true,
              type: "ask",
              message: "Request sent to\n" + p.label + "!",
            });
          }

          const sent = await bot.api.sendMessage(
            senderId,
            "Tip " + p.amount + " GRAM to " + p.label + "?\nValid for 5 minutes.",
            { reply_markup: new InlineKeyboard().webApp("Review & sign", payLink(p.user, p.amount, id)) }
          );
          const me = load()[senderId];
          if (me?.address) {
            watching.set(id, {
              senderAddr: me.address,
              senderId,
              senderLabel: userLabel(me),
              recipientId: p.user.id,
              recipientAddr: p.user.address,
              nano: String(Math.round(p.amount * 1e9)),
              amount: p.amount,
              label: p.label,
              messageId: sent.message_id,
              since: Date.now(),
              status: "waiting",
            });
          }
          return reply(res, 200, { ok: true, type: "tip" });
        }

        if (req.url === "/status") {
          const { id } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
          const w = watching.get(id);
          if (!w || String(w.senderId) !== String(senderId)) {
            return reply(res, 200, { status: "unknown" });
          }
          return reply(res, 200, {
            status: w.status,
            amount: w.amount,
            label: w.label,
          });
        }

        res.writeHead(404);
        res.end();
      } catch (e) {
        console.error("API ERROR:", e.message);
        reply(res, 500, { error: String(e.message) });
      }
    })
    .listen(port, host, () => console.log("API on http://127.0.0.1:" + port));
}