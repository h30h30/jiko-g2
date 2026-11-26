import http from "node:http";
import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import {
  parseCommand,
  findRecipient,
  payLink,
  inviteShareUrl,
  load,
  loadSessions,
  saveSessions,
  short,
  canonicalAddr,
  createInviteDraft,
  isDbEnabled,
  isNotionAllowed,
  registerReplyRoute,
  popInboxMessage,
  getLastInboxSender,
} from "./core.js";
import {
  isNotionEnabled,
  saveNotionEntry,
  fetchNotionEntriesData,
  fetchRecentNotionEntries,
  fetchOpenTasks,
  completeNotionTask,
  searchNotionEntries,
} from "./notion.js";

const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";
const GROQ_LLM_MODEL = process.env.GROQ_LLM_MODEL || "openai/gpt-oss-20b";
export const COFFEE_PRICE_USD = Number(process.env.COFFEE_PRICE_USD) || 5;
const MAX_TESTNET_GRAM = 25;

export function getUserCoffeeUsd(userId) {
  const custom = Number(load()[String(userId)]?.coffeeUsd);
  return Number.isFinite(custom) && custom > 0 ? custom : COFFEE_PRICE_USD;
}

// Privacy-first: ONLY include explicit opt-in /voicename aliases
function getOptInVoiceNames() {
  const names = new Set();
  for (const u of Object.values(load())) {
    const alias = (u.alias || "").trim();
    if (alias) names.add(alias);
  }
  return [...names].slice(0, 20);
}

const TONCENTER_TX = "https://testnet.toncenter.com/api/v2/getTransactions";
const TONCENTER_BAL = "https://testnet.toncenter.com/api/v2/getAddressBalance";

const pending = new Map();
const watching = new Map();
const pairCodes = new Map();
const balanceCache = new Map();
let tonPriceCache = null;

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

// Live TON/USD mainnet reference rate (60s cache + 3 public fallbacks)
export async function fetchTonPriceUsd(force = false) {
  if (!force && tonPriceCache && Date.now() - tonPriceCache.at < 60_000) {
    return tonPriceCache.price;
  }
  const t0 = Date.now();
  const sources = [
    {
      name: "TonAPI",
      url: "https://tonapi.io/v2/rates?tokens=ton&currencies=usd",
      pick: (j) => Number(j?.rates?.TON?.prices?.USD),
    },
    {
      name: "CoinGecko",
      url: "https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd",
      pick: (j) => Number(j?.["the-open-network"]?.usd),
    },
    {
      name: "Kraken",
      url: "https://api.kraken.com/0/public/Ticker?pair=TONUSD",
      pick: (j) => Number(Object.values(j?.result ?? {})[0]?.c?.[0]),
    },
  ];

  for (const src of sources) {
    try {
      const r = await fetch(src.url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const json = await r.json();
      const price = src.pick(json);
      if (Number.isFinite(price) && price > 0) {
        tonPriceCache = { price, at: Date.now() };
        console.log(`[TIMING] TON/USD (${src.name}): $${price.toFixed(2)} in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
        return price;
      }
    } catch {
      // try next fallback source
    }
  }

  if (tonPriceCache) return tonPriceCache.price;
  throw new Error("Could not fetch live TON/USD price");
}

function usdToGram(usd, tonPrice) {
  return Math.max(0.01, Number((usd / tonPrice).toFixed(2)));
}

function fmtUsd(usd) {
  return "$" + Number(usd).toFixed(usd % 1 === 0 ? 0 : 2);
}

async function transcribe(pcm) {
  if (!process.env.GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");
  const t0 = Date.now();
  const wav = wavFromPcm(pcm);
  const optInNames = getOptInVoiceNames();
  const sttPrompt =
    "Jiko on Even G2 glasses. Voice commands for TON, GRAM, USD, coffee tips, Telegram messages, replies, new task, add task, mark as done, catch me up, balance, and Notion notes." +
    (optInNames.length ? " Opt-in voice names: " + optInNames.join(", ") + "." : "");

  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("model", GROQ_STT_MODEL);
  form.append("temperature", "0");
  form.append("language", "en");
  form.append("prompt", sttPrompt);
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
    `[TIMING] Groq Whisper STT: ${((Date.now() - t0) / 1000).toFixed(2)}s (${(pcm.length / 32000).toFixed(1)}s audio) -> "${text}"`
  );
  return text;
}

async function understandVoice(transcript) {
  const rawTranscript = (transcript ?? "").trim();

  // Fast-path: explicit "tell/message/text <contact> ..." never gets misrouted
  const directMsg = rawTranscript.match(
    /^(?:tell|message|text)\s+@?([a-z0-9_]+)[,:\s]+(?:(?:that|to)\s+)?(.+)$/i
  );
  if (directMsg && !/^(me|us)$/i.test(directMsg[1]) && directMsg[2].trim()) {
    const matched = findRecipient(directMsg[1]);
    if (matched && !matched.ambiguous) {
      return {
        type: "message",
        name: directMsg[1],
        body: directMsg[2].trim().slice(0, 140),
      };
    }
  }

  if (!process.env.GROQ_API_KEY) return parseCommand(rawTranscript);
  const t0 = Date.now();
  const optInNames = getOptInVoiceNames();
  const contactsHint = optInNames.length
    ? `Opt-in voice names: ${optInNames.join(", ")}. Match phonetically close spoken names to an opt-in voice name when clearly intended.\n`
    : "";
  const todayIso = new Date().toISOString().slice(0, 10);

  const systemPrompt =
    `You are Jiko, a smart voice assistant on Even G2 smart glasses connected to Telegram, a TON testnet tip wallet, and Notion. Today is ${todayIso}.\n` +
    contactsHint +
    'Treat "TON", "Toncoin", and "GRAM" identically as the same tipping token (unit: "gram").\n' +
    'PRIORITY RULE: If the user starts with "tell <person> ...", "message <person> ...", "text <person> ...", or "reply ..." (where <person> is NOT "me" or "us"), ALWAYS classify it as type "message" — even if the message body mentions chores/tasks or wallet words. Strip leading "to " or "that " from the message body.\n' +
    "Classify the user's spoken input into ONE JSON object (raw JSON only):\n" +
    '1) Sending a tip in TON/GRAM or USD/dollars: {"type":"tip","amount":<number>,"unit":"gram"|"usd","name":"<recipient name>"}\n' +
    '2) Buying someone coffee(s): {"type":"coffee","count":<integer >= 1>,"name":"<recipient name>"}\n' +
    '3) Requesting money from someone in TON/GRAM or USD/dollars: {"type":"ask","amount":<number>,"unit":"gram"|"usd","name":"<payer name>"}\n' +
    '4) Sending a short Telegram message or replying to someone: {"type":"message","name":"<recipient name or empty string>","body":"<clean message text>"}\n' +
    '5) Adding an actionable task/todo to Notion — ONLY when the user explicitly says "new task", "add task", "create task", or "todo" (never turn general statements or rename requests into a task): {"type":"task","content":"<clean task text>","due":"<YYYY-MM-DD if date mentioned, else empty string>"}\n' +
    '6) Listing open/pending Notion tasks (e.g. "what are my open tasks?", "show my todos"): {"type":"tasks"}\n' +
    '7) Marking a Notion task as done/complete (e.g. "mark demo video as done", "complete pitch deck"): {"type":"complete_task","query":"<task keywords>"}\n' +
    '8) Quick workspace + wallet briefing (e.g. "catch me up", "brief me", "give me my daily brief"): {"type":"brief"}\n' +
    '9) Saving a general voice note or memo to Notion (personal note, never "tell <person> ..."): {"type":"note","content":"<clean note text>"}\n' +
    '10) Searching Notion notes/tasks for a specific topic (e.g. "what did I note about pitch deck?", "find notes about Telegram"): {"type":"notion_search","query":"<topic or question>"}\n' +
    '11) Simply listing the latest Notion entries: {"type":"notes"}\n' +
    '12) Summarizing or asking about total spending/tips/activity in Notion: {"type":"notion_summary","question":"<user question>"}\n' +
    '13) Checking live TON/USD reference rate: {"type":"price"}\n' +
    '14) Checking wallet balance: {"type":"balance"}\n' +
    '15) Checking recent TON transactions/activity: {"type":"history"}\n' +
    '16) Any general question, math calculation, translation, crypto concept, or assistant query: {"type":"answer","reply":"<ultra-concise answer>"}\n' +
    "Rules for 'answer': max 3 short lines (under 110 characters total), plain text only, no emojis or markdown. " +
    "IMPORTANT: Never guess live prices for other coins (like BTC/ETH) or current weather; if asked for live data other than TON/USD, briefly say only live TON/USD is connected.";

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
          { role: "user", content: rawTranscript },
        ],
      }),
    });
    if (!res.ok) throw new Error("Groq LLM " + res.status + ": " + (await res.text()).slice(0, 150));
    const json = await res.json();
    const raw = (json.choices?.[0]?.message?.content ?? "").trim();
    const parsed = JSON.parse(raw);
    console.log(`[TIMING] Groq AI intent (${parsed.type}): ${((Date.now() - t0) / 1000).toFixed(2)}s`);

    if (parsed.type === "tip" && Number(parsed.amount) > 0 && parsed.name) {
      const unit = String(parsed.unit || "gram").toLowerCase() === "usd" ? "usd" : "gram";
      return { type: "tip", amount: Number(parsed.amount), unit, name: String(parsed.name).trim() };
    }
    if (parsed.type === "coffee" && parsed.name) {
      const count = Math.max(1, Math.min(10, Math.round(Number(parsed.count) || 1)));
      return { type: "coffee", count, name: String(parsed.name).trim() };
    }
    if (parsed.type === "ask" && Number(parsed.amount) > 0 && parsed.name) {
      const unit = String(parsed.unit || "gram").toLowerCase() === "usd" ? "usd" : "gram";
      return { type: "ask", amount: Number(parsed.amount), unit, name: String(parsed.name).trim() };
    }
    if (parsed.type === "message" && parsed.body) {
      return {
        type: "message",
        name: String(parsed.name || "").trim(),
        body: String(parsed.body).trim().slice(0, 140),
      };
    }
    if (parsed.type === "task" && parsed.content) {
      return {
        type: "task",
        content: String(parsed.content).trim(),
        due: String(parsed.due || "").trim(),
      };
    }
    if (parsed.type === "complete_task") {
      return { type: "complete_task", query: String(parsed.query || "").trim() };
    }
    if (parsed.type === "notion_search") {
      return { type: "notion_search", query: String(parsed.query || rawTranscript).trim() };
    }
    if (parsed.type === "note" && parsed.content) {
      return { type: "note", content: String(parsed.content).trim() };
    }
    if (parsed.type === "notion_summary") {
      return { type: "notion_summary", question: String(parsed.question || rawTranscript).trim() };
    }
    if (
      parsed.type === "tasks" ||
      parsed.type === "brief" ||
      parsed.type === "price" ||
      parsed.type === "balance" ||
      parsed.type === "history" ||
      parsed.type === "notes"
    ) {
      return { type: parsed.type };
    }
    if (parsed.type === "answer" && parsed.reply) {
      return { type: "answer", reply: String(parsed.reply).trim().slice(0, 140) };
    }
  } catch (e) {
    console.error("AI ROUTER FALLBACK:", e.message);
  }

  return parseCommand(rawTranscript);
}

async function summarizeNotion(question) {
  const entries = await fetchNotionEntriesData(25);
  if (!entries.length) return "Notion log is empty.";

  let tipCount = 0;
  let totalGram = 0;
  let openTasks = 0;
  let doneTasks = 0;
  let noteCount = 0;

  for (const e of entries) {
    const m = e.title.match(/^tip:\s*(\d+(?:\.\d+)?)\s*(?:gram|ton)/i);
    if (m || /crypto tip/i.test(e.tag)) {
      tipCount++;
      if (typeof e.amount === "number" && e.amount > 0) totalGram += e.amount;
      else if (m) totalGram += Number(m[1]);
    } else if (/task/i.test(e.tag)) {
      if (e.done) doneTasks++;
      else openTasks++;
    } else {
      noteCount++;
    }
  }

  const tonPrice = await fetchTonPriceUsd().catch(() => null);
  const usdSuffix = tonPrice ? ` (~$${(totalGram * tonPrice).toFixed(2)} ref)` : "";
  const fallback =
    `Notion summary (testnet):\n` +
    `Tips: ${tipCount} (${totalGram.toFixed(2)} GRAM${usdSuffix})\n` +
    `Tasks: ${openTasks} open, ${doneTasks} done · Notes: ${noteCount}`;

  if (!process.env.GROQ_API_KEY) return fallback;

  const t0 = Date.now();
  const listText = entries
    .map((e, i) => {
      const status = /task/i.test(e.tag) ? (e.done ? "DONE" : "OPEN") : e.tag || "Entry";
      return `${i + 1}. [${status} | ${e.date}] ${e.title}`;
    })
    .join("\n");

  const prompt =
    "You are Jiko on Even G2 smart glasses. Answer the user's question using ONLY the Notion workspace entries and exact pre-calculated stats below.\n" +
    "Format rules: max 4 short lines (under 140 characters total), plain text only, no markdown, no emojis, no invented facts. Mention 'ref, testnet' when quoting USD values.\n\n" +
    `Exact stats: ${tipCount} testnet tips totaling ${totalGram.toFixed(2)} GRAM${usdSuffix}; ${openTasks} open tasks, ${doneTasks} done tasks; ${noteCount} notes.\n` +
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

async function searchNotionWithAi(query) {
  const { matched, all } = await searchNotionEntries(query, 30);
  if (!all.length) return "Notion log is empty.";

  if (matched.length && !process.env.GROQ_API_KEY) {
    const lines = matched.slice(0, 3).map((e) => "- " + e.title.slice(0, 30));
    return "Matches:\n" + lines.join("\n");
  }

  const contextList = (matched.length ? matched.slice(0, 8) : all.slice(0, 15))
    .map((e, i) => {
      const status = /task/i.test(e.tag) ? (e.done ? "DONE" : "OPEN") : e.tag || "Note";
      return `${i + 1}. [${status} | ${e.date}] ${e.title}`;
    })
    .join("\n");

  const t0 = Date.now();
  const prompt =
    "You are Jiko on Even G2 smart glasses. Answer the user's lookup query using ONLY the Notion entries below. If nothing matches, say no matching Notion entry was found.\n" +
    "Format rules: max 4 short lines (under 140 characters total), plain text only, no markdown, no emojis.\n\n" +
    `Notion entries:\n${contextList}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: GROQ_LLM_MODEL,
        temperature: 0.1,
        max_tokens: 1024,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: query },
        ],
      }),
    });
    if (!res.ok) throw new Error("Groq Notion search " + res.status);
    const json = await res.json();
    const replyText = (json.choices?.[0]?.message?.content ?? "").trim();
    console.log(`[TIMING] Groq Notion search: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    if (replyText) return replyText.slice(0, 160);
  } catch (e) {
    console.error("NOTION SEARCH FALLBACK:", e.message);
  }

  if (!matched.length) return 'No Notion match for\n"' + query.slice(0, 28) + '"';
  return "Matches:\n" + matched.slice(0, 3).map((e) => "- " + e.title.slice(0, 30)).join("\n");
}

async function buildBriefing(senderId, me) {
  const canNotion = isNotionEnabled() && isNotionAllowed(senderId, me);
  const [balRes, priceRes, entriesRes] = await Promise.allSettled([
    me?.address ? fetchBalance(me.address) : Promise.resolve(null),
    fetchTonPriceUsd(),
    canNotion ? fetchNotionEntriesData(25) : Promise.resolve(null),
  ]);

  const lines = ["Jiko Briefing"];

  if (entriesRes.status === "fulfilled" && Array.isArray(entriesRes.value)) {
    const entries = entriesRes.value;
    const openTasks = entries.filter((e) => /task/i.test(e.tag) && !e.done);
    const latestNote = entries.find((e) => !/task/i.test(e.tag) && !/crypto tip/i.test(e.tag));

    if (openTasks.length) {
      const next = openTasks[0].title.length > 22 ? openTasks[0].title.slice(0, 19) + "..." : openTasks[0].title;
      lines.push(`Open tasks: ${openTasks.length} (${next})`);
    } else {
      lines.push("Open tasks: 0 (all clear)");
    }

    if (latestNote) {
      const n = latestNote.title.length > 24 ? latestNote.title.slice(0, 21) + "..." : latestNote.title;
      lines.push("Note: " + n);
    }
  } else {
    lines.push("Notion: not connected");
  }

  const bal = balRes.status === "fulfilled" ? balRes.value : null;
  const price = priceRes.status === "fulfilled" ? priceRes.value : null;
  if (bal) {
    const ref = price ? ` (~$${(Number(bal) * price).toFixed(2)} ref)` : "";
    lines.push(`Wallet: ${bal} GRAM${ref}`);
  } else if (price) {
    lines.push(`TON ref: $${price.toFixed(2)}`);
  }

  return lines.join("\n");
}

async function fetchBalance(address, force = false) {
  const cached = balanceCache.get(address);
  if (!force && cached && Date.now() - cached.at < 15_000) {
    return cached.val;
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1100));
    try {
      const t0 = Date.now();
      const r = await fetch(TONCENTER_BAL + "?address=" + encodeURIComponent(address), {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) {
        lastErr = new Error("Toncenter " + r.status);
        continue;
      }
      const json = await r.json();
      if (!json.ok) {
        lastErr = new Error(json.error || "Toncenter error");
        continue;
      }
      const val = (Number(json.result) / 1e9).toFixed(2);
      balanceCache.set(address, { val, at: Date.now() });
      console.log(`[TIMING] Toncenter balance: ${((Date.now() - t0) / 1000).toFixed(2)}s`);
      return val;
    } catch (e) {
      lastErr = e;
    }
  }

  if (cached) return cached.val;
  throw lastErr || new Error("Toncenter balance unavailable");
}

async function fetchHistory(address) {
  const t0 = Date.now();
  const r = await fetch(TONCENTER_TX + "?address=" + encodeURIComponent(address) + "&limit=6", {
    signal: AbortSignal.timeout(5000),
  });
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

// 4 clean cards: 1/4 Welcome · 2/4 Wallet · 3/4 Notion · 4/4 Instructions
async function buildCards(address, senderId, me) {
  const canUseNotion = isNotionEnabled() && isNotionAllowed(senderId, me);
  const [balRes, priceRes, notionRes] = await Promise.allSettled([
    fetchBalance(address),
    fetchTonPriceUsd(),
    canUseNotion
      ? fetchRecentNotionEntries(3)
      : Promise.resolve(isNotionEnabled() ? "__RESTRICTED__" : "__DISABLED__"),
  ]);

  const greetingName = me?.alias || me?.first_name || (me?.username ? "@" + me.username : "friend");
  const card1 =
    "Welcome to Jiko · 1/4\n" +
    `Hi ${greetingName}!\n` +
    "Voice AI for Notion,\n" +
    "Telegram & TON tips";

  const bal = balRes.status === "fulfilled" ? balRes.value : null;
  const tonPrice = priceRes.status === "fulfilled" ? priceRes.value : null;

  const balLine = (bal ?? "--") + " GRAM (testnet)";
  const refLine =
    bal && tonPrice
      ? `Ref: ~$${(Number(bal) * tonPrice).toFixed(2)} · TON $${tonPrice.toFixed(2)}`
      : tonPrice
        ? `TON ref: $${tonPrice.toFixed(2)}`
        : "";
  const addrLine = short(address) + " (no real value)";

  const card2 = ["Wallet · 2/4", balLine, refLine, addrLine].filter(Boolean).join("\n");

  let card3 = "Notion · 3/4\nCould not load notes";
  if (notionRes.status === "fulfilled") {
    if (notionRes.value === "__DISABLED__") {
      card3 = "Notion · 3/4\nNot connected";
    } else if (notionRes.value === "__RESTRICTED__") {
      card3 = "Notion · 3/4\nDemo workspace only";
    } else {
      const body = notionRes.value.replace(/^Notion log:\n?/i, "");
      card3 = "Notion · 3/4\n" + body;
    }
  }

  const card4 =
    "Instructions · 4/4\n" +
    '• "Add task: demo video"\n' +
    '• "Mark demo video done"\n' +
    '• "Buy Alex a coffee"\n' +
    '• "Tell Alex I\'m 5m late"';

  return { balance: bal, cards: [card1, card2, card3, card4] };
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
      balanceCache.delete(w.senderAddr);
      if (w.recipientAddr) balanceCache.delete(w.recipientAddr);

      const extraTag = w.noteTag
        ? ` (${w.noteTag}${w.usdDisplay ? " · " + w.usdDisplay : ""})`
        : w.usdDisplay
          ? ` (${w.usdDisplay})`
          : "";

      let notionSuffix = "";
      const senderRecord = load()[String(w.senderId)];
      if (isNotionEnabled() && isNotionAllowed(w.senderId, senderRecord)) {
        try {
          let usdNum = typeof w.usdRefNum === "number" ? w.usdRefNum : null;
          if (usdNum === null) {
            const p = await fetchTonPriceUsd().catch(() => null);
            if (p) usdNum = Number((Number(w.amount) * p).toFixed(2));
          }
          await saveNotionEntry({
            kind: "tip",
            title: `Tip: ${w.amount} GRAM -> ${w.label}${extraTag}`,
            details: `From ${w.senderLabel} to ${w.label} · ${w.amount} GRAM${extraTag} (TON Testnet, no real value) · Logged automatically by Jiko`,
            amount: Number(w.amount),
            usdRef: usdNum,
          });
          notionSuffix = "\n📒 Logged to Notion.";
        } catch (e) {
          console.error("NOTION LOG ERROR:", e.message);
        }
      }

      const sentHeadline = w.coffeeCount
        ? `☕ Bought ${w.label} ${w.coffeeCount} ${w.coffeeCount > 1 ? "coffees" : "coffee"} (${w.amount} GRAM · ${w.usdDisplay}, testnet · no real value).`
        : `✅ Sent ${w.amount} GRAM${w.usdDisplay ? " (" + w.usdDisplay + ")" : ""} to ${w.label} (testnet · no real value).`;

      await notify(bot, w, sentHeadline + notionSuffix);

      if (w.recipientId && String(w.recipientId) !== String(w.senderId)) {
        const rxMsg = w.coffeeCount
          ? `☕ ${w.senderLabel} bought you ${w.coffeeCount} ${w.coffeeCount > 1 ? "coffees" : "coffee"} (${w.amount} GRAM · ${w.usdDisplay}, testnet · no real value)!`
          : `💸 You received ${w.amount} GRAM from ${w.senderLabel} (testnet · no real value).`;
        await bot.api.sendMessage(w.recipientId, rxMsg).catch(() => {});
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
        return reply(res, 200, {
          ok: true,
          service: "jiko",
          db: isDbEnabled(),
          notion: isNotionEnabled(),
          coffeeUsd: COFFEE_PRICE_USD,
        });
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

        if (req.url === "/inbox") {
          const item = popInboxMessage(senderId);
          return reply(res, 200, { ok: true, message: item || null });
        }

        if (req.url === "/cards") {
          const me = load()[senderId];
          if (!me?.address) return reply(res, 401, { ok: false, error: "Wallet unlinked" });
          const data = await buildCards(me.address, senderId, me);
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
              message: 'Didn\'t get that.\nTry: "Add task: ...",\n"Buy Alex a coffee", or "Catch me up"',
            });
          }

          const me = load()[senderId];

          // Quick HUD briefing (open tasks + latest note + wallet)
          if (cmd.type === "brief") {
            try {
              const msg = await buildBriefing(senderId, me);
              return reply(res, 200, {
                ok: true,
                type: "answer",
                refreshCards: true,
                message: msg,
              });
            } catch (e) {
              console.error("BRIEF ERROR:", e.message);
              return reply(res, 200, { ok: false, message: "Could not load briefing.\nTry again." });
            }
          }

          // Hands-free Telegram message / voice reply
          if (cmd.type === "message") {
            const bodyText = String(cmd.body || "").trim().slice(0, 140);
            if (!bodyText) {
              return reply(res, 200, { ok: false, message: "No message text heard." });
            }

            let targetUser = null;
            const rawName = String(cmd.name || "").trim();
            const isGenericReply = !rawName || /^(them|back|him|her|reply)$/i.test(rawName);

            if (isGenericReply) {
              const lastIn = getLastInboxSender(senderId);
              if (lastIn) {
                const dbRec = load()[lastIn.fromId];
                targetUser = dbRec
                  ? { ...dbRec, id: lastIn.fromId }
                  : { id: lastIn.fromId, first_name: lastIn.fromLabel };
              } else {
                return reply(res, 200, {
                  ok: false,
                  message: 'No recent reply to answer.\nSay: "Tell Alex I\'m 5m late"',
                });
              }
            } else {
              const found = findRecipient(rawName);
              if (found?.ambiguous) {
                return reply(res, 200, {
                  ok: false,
                  message: 'Several matches for\n"' + rawName + '".\nSay the voice name.',
                });
              }
              if (!found) {
                return reply(res, 200, {
                  ok: false,
                  message: 'No Jiko user found for\n"' + rawName + '"',
                });
              }
              targetUser = found;
            }

            const id = crypto.randomBytes(8).toString("hex");
            const label = targetUser.username
              ? "@" + targetUser.username
              : targetUser.first_name || rawName || "user";
            const preview = bodyText.length > 52 ? bodyText.slice(0, 49) + "..." : bodyText;

            pending.set(id, {
              kind: "message",
              senderId,
              recipient: targetUser,
              body: bodyText,
              label,
              at: Date.now(),
            });

            return reply(res, 200, {
              ok: true,
              type: "message",
              id,
              summary: `Message ${label}:\n"${preview}"`,
            });
          }

          // Notion: Add actionable task
          if (cmd.type === "task") {
            if (!isNotionEnabled()) {
              return reply(res, 200, { ok: false, message: "Notion not configured." });
            }
            if (!isNotionAllowed(senderId, me)) {
              return reply(res, 200, { ok: false, message: "Shared Notion log is restricted\nto demo accounts." });
            }
            try {
              await saveNotionEntry({
                kind: "task",
                title: cmd.content,
                details: `Task added by ${userLabel(me)} via Even G2 glasses`,
                done: false,
                due: cmd.due || null,
              });
              const preview = cmd.content.length > 54 ? cmd.content.slice(0, 51) + "..." : cmd.content;
              const dueSuffix = cmd.due ? `\nDue: ${cmd.due}` : "";
              return reply(res, 200, {
                ok: true,
                type: "answer",
                refreshCards: true,
                message: `Task added to Notion:\n[ ] ${preview}${dueSuffix}`,
              });
            } catch (e) {
              console.error("NOTION TASK ERROR:", e.message);
              return reply(res, 200, { ok: false, message: "Could not save task to Notion." });
            }
          }

          // Notion: List open tasks only
          if (cmd.type === "tasks") {
            if (!isNotionEnabled()) {
              return reply(res, 200, { ok: false, message: "Notion not configured." });
            }
            if (!isNotionAllowed(senderId, me)) {
              return reply(res, 200, { ok: false, message: "Shared Notion log is restricted\nto demo accounts." });
            }
            try {
              const open = await fetchOpenTasks(30);
              if (!open.length) {
                return reply(res, 200, {
                  ok: true,
                  type: "answer",
                  message: "Open tasks: 0\nAll caught up!",
                });
              }
              const lines = open.slice(0, 4).map((t) => {
                const c = t.title.length > 28 ? t.title.slice(0, 25) + "..." : t.title;
                return "[ ] " + c;
              });
              return reply(res, 200, {
                ok: true,
                type: "answer",
                message: `Open tasks (${open.length}):\n` + lines.join("\n"),
              });
            } catch (e) {
              console.error("NOTION TASKS READ ERROR:", e.message);
              return reply(res, 200, { ok: false, message: "Could not load open tasks." });
            }
          }

          // Notion: Live-check a task as Done (PATCH)
          if (cmd.type === "complete_task") {
            if (!isNotionEnabled()) {
              return reply(res, 200, { ok: false, message: "Notion not configured." });
            }
            if (!isNotionAllowed(senderId, me)) {
              return reply(res, 200, { ok: false, message: "Shared Notion log is restricted\nto demo accounts." });
            }
            try {
              const resTask = await completeNotionTask(cmd.query);
              if (resTask.missingCheckbox) {
                return reply(res, 200, {
                  ok: false,
                  message: 'Add a "Done" checkbox\ncolumn in Notion first.',
                });
              }
              if (resTask.notFound) {
                return reply(res, 200, {
                  ok: false,
                  message: 'No open task matching\n"' + (cmd.query || "that").slice(0, 26) + '"',
                });
              }
              const title = resTask.task.title;
              const preview = title.length > 52 ? title.slice(0, 49) + "..." : title;
              return reply(res, 200, {
                ok: true,
                type: "answer",
                refreshCards: true,
                message: `Done in Notion:\n[x] ${preview}`,
              });
            } catch (e) {
              console.error("NOTION COMPLETE ERROR:", e.message);
              return reply(res, 200, { ok: false, message: "Could not update task in Notion." });
            }
          }

          // Notion: Search notes/tasks by topic
          if (cmd.type === "notion_search") {
            if (!isNotionEnabled()) {
              return reply(res, 200, { ok: false, message: "Notion not configured." });
            }
            if (!isNotionAllowed(senderId, me)) {
              return reply(res, 200, { ok: false, message: "Shared Notion log is restricted\nto demo accounts." });
            }
            try {
              const msg = await searchNotionWithAi(cmd.query);
              return reply(res, 200, { ok: true, type: "answer", message: msg });
            } catch (e) {
              console.error("NOTION SEARCH ERROR:", e.message);
              return reply(res, 200, { ok: false, message: "Could not search Notion." });
            }
          }

          // Live TON/USD reference rate
          if (cmd.type === "price") {
            try {
              const price = await fetchTonPriceUsd(true);
              const coffeeUsd = getUserCoffeeUsd(senderId);
              const coffeeGram = usdToGram(coffeeUsd, price);
              return reply(res, 200, {
                ok: true,
                type: "answer",
                refreshCards: true,
                message:
                  `TON/USD ref: $${price.toFixed(2)}\n` +
                  `1 coffee (${fmtUsd(coffeeUsd)}) = ${coffeeGram} GRAM\n` +
                  `(testnet, no real value)`,
              });
            } catch (e) {
              console.error("PRICE ERROR:", e.message);
              return reply(res, 200, {
                ok: false,
                message: "Could not fetch live TON rate.\nTry again.",
              });
            }
          }

          // Save voice note directly to Notion
          if (cmd.type === "note") {
            if (!isNotionEnabled()) {
              return reply(res, 200, {
                ok: false,
                message: "Notion not configured.\nSet NOTION_API_KEY &\nNOTION_DATABASE_ID",
              });
            }
            if (!isNotionAllowed(senderId, me)) {
              return reply(res, 200, {
                ok: false,
                message: "Shared Notion log is restricted\nto demo accounts.",
              });
            }
            try {
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
            if (!isNotionAllowed(senderId, me)) {
              return reply(res, 200, {
                ok: false,
                message: "Shared Notion log is restricted\nto demo accounts.",
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
            if (!isNotionAllowed(senderId, me)) {
              return reply(res, 200, {
                ok: false,
                message: "Shared Notion log is restricted\nto demo accounts.",
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
            if (!me?.address) {
              return reply(res, 200, {
                ok: false,
                message: "No wallet linked.\nOpen Jiko bot and press /start",
              });
            }
            try {
              const [bal, tonPrice] = await Promise.all([
                fetchBalance(me.address, true),
                fetchTonPriceUsd().catch(() => null),
              ]);
              const usdPart = tonPrice ? ` (~$${(Number(bal) * tonPrice).toFixed(2)} ref)` : "";
              const ratePart = tonPrice ? `\nTON ref: $${tonPrice.toFixed(2)}` : "";
              return reply(res, 200, {
                ok: true,
                type: "balance",
                balance: bal,
                refreshCards: true,
                message: `Balance: ${bal} GRAM${usdPart}${ratePart}\n${short(me.address)} (testnet, no real value)`,
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
            let amountGram = cmd.amount;
            let usdDisplay = "";
            let usdRefNum = null;
            if (cmd.unit === "usd") {
              const tonPrice = await fetchTonPriceUsd().catch(() => null);
              if (!tonPrice) {
                return reply(res, 200, { ok: false, message: "Live TON rate unavailable.\nSay amount in GRAM." });
              }
              amountGram = usdToGram(cmd.amount, tonPrice);
              usdDisplay = fmtUsd(cmd.amount) + " ref";
              usdRefNum = Number(cmd.amount);
            } else {
              const tonPrice = await fetchTonPriceUsd().catch(() => null);
              if (tonPrice) {
                usdRefNum = Number((amountGram * tonPrice).toFixed(2));
                usdDisplay = "~$" + usdRefNum.toFixed(2) + " ref";
              }
            }

            if (amountGram > MAX_TESTNET_GRAM) {
              return reply(res, 200, { ok: false, message: `Max ${MAX_TESTNET_GRAM} GRAM (testnet)` });
            }
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
            pending.set(id, {
              kind: "ask",
              senderId,
              payer,
              amount: amountGram,
              usdDisplay,
              usdRefNum,
              label,
              at: Date.now(),
            });
            return reply(res, 200, {
              ok: true,
              type: "ask",
              id,
              summary: `Ask ${label} for\n${amountGram} GRAM${usdDisplay ? " (" + usdDisplay + ")" : ""}?\n(testnet)`,
            });
          }

          // Buy someone a coffee OR Tip
          let amountGram = cmd.amount;
          let usdDisplay = "";
          let usdRefNum = null;
          let coffeeCount = 0;
          let noteTag = "";

          if (cmd.type === "coffee") {
            coffeeCount = cmd.count || 1;
            const totalUsd = coffeeCount * getUserCoffeeUsd(senderId);
            const tonPrice = await fetchTonPriceUsd().catch(() => null);
            if (!tonPrice) {
              return reply(res, 200, { ok: false, message: "Live TON rate unavailable.\nTry again." });
            }
            amountGram = usdToGram(totalUsd, tonPrice);
            usdRefNum = Number(totalUsd.toFixed(2));
            usdDisplay = fmtUsd(totalUsd) + " ref";
            noteTag = `Coffee x${coffeeCount}`;
          } else if (cmd.unit === "usd") {
            const tonPrice = await fetchTonPriceUsd().catch(() => null);
            if (!tonPrice) {
              return reply(res, 200, { ok: false, message: "Live TON rate unavailable.\nSay amount in GRAM." });
            }
            amountGram = usdToGram(cmd.amount, tonPrice);
            usdRefNum = Number(Number(cmd.amount).toFixed(2));
            usdDisplay = fmtUsd(cmd.amount) + " ref";
          } else {
            const tonPrice = await fetchTonPriceUsd().catch(() => null);
            if (tonPrice) {
              usdRefNum = Number((amountGram * tonPrice).toFixed(2));
              usdDisplay = "~$" + usdRefNum.toFixed(2) + " ref";
            }
          }

          if (amountGram > MAX_TESTNET_GRAM) {
            return reply(res, 200, { ok: false, message: `Max ${MAX_TESTNET_GRAM} GRAM (testnet)` });
          }

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
              amount: amountGram,
              coffeeCount,
              at: Date.now(),
            });
            return reply(res, 200, {
              ok: true,
              type: "invite",
              id,
              summary: 'No wallet for "' + cmd.name + '".\nSend invite (' + amountGram + " GRAM)?",
            });
          }

          const id = crypto.randomBytes(8).toString("hex");
          const label = user.username ? "@" + user.username : user.first_name || cmd.name;
          pending.set(id, {
            kind: "tip",
            senderId,
            user,
            amount: amountGram,
            usdDisplay,
            usdRefNum,
            coffeeCount,
            noteTag,
            label,
            at: Date.now(),
          });

          const summary = coffeeCount
            ? `Buy ${label} ${coffeeCount} ${coffeeCount > 1 ? "coffees" : "coffee"}?\n${amountGram} GRAM (${usdDisplay}, testnet)`
            : `Send ${amountGram} GRAM${usdDisplay ? " (" + usdDisplay + ")" : ""}\nto ${label}? (testnet)`;

          return reply(res, 200, {
            ok: true,
            type: "tip",
            id,
            summary,
          });
        }

        if (req.url === "/confirm") {
          const { id } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
          const p = pending.get(id);
          pending.delete(id);
          if (!p || p.senderId !== senderId || Date.now() - p.at > 60_000) {
            return reply(res, 200, { ok: false, message: "Expired" });
          }

          if (p.kind === "message") {
            const me = load()[senderId];
            const senderLabel = userLabel(me);
            const sentMsg = await bot.api
              .sendMessage(
                p.recipient.id,
                `💬 Message from ${senderLabel} (via Jiko G2):\n"${p.body}"\n\n↩️ Reply directly to this message (or send /reply <text>) to answer on their glasses.`
              )
              .catch(() => null);

            if (!sentMsg) {
              return reply(res, 200, { ok: false, message: "Could not reach " + p.label });
            }

            registerReplyRoute(sentMsg.message_id, p.recipient.id, senderId, senderLabel);

            if (String(p.recipient.id) !== String(senderId)) {
              await bot.api
                .sendMessage(senderId, `💬 Sent to ${p.label}: "${p.body}"`)
                .catch(() => {});
            }

            return reply(res, 200, {
              ok: true,
              type: "message",
              message: "Sent to " + p.label + "!",
            });
          }

          if (p.kind === "invite") {
            const cleanName = p.targetName.toLowerCase().replace(/^@/, "").replace(/\s+/g, "");
            const draftId = createInviteDraft(senderId, cleanName, p.amount, p.coffeeCount || 0);
            const kb = new InlineKeyboard()
              .url("🎁 Send invite to @" + cleanName, inviteShareUrl(p.coffeeCount || 0))
              .row()
              .text("🔔 Notify me when @" + cleanName + " joins (24h)", "wait:" + draftId);

            await bot.api.sendMessage(
              senderId,
              "@" + cleanName + " hasn't linked a wallet yet.\n" +
                "Tap below to send them a ready-made invite message (no funds move until they join and you sign).",
              {
                reply_markup: kb,
                link_preview_options: { is_disabled: true },
              }
            );
            return reply(res, 200, {
              ok: true,
              type: "invite",
              message: "Invite ready in Telegram!\nTap to send to @" + cleanName,
            });
          }

          if (p.kind === "ask") {
            const me = load()[senderId];
            if (!me?.address) {
              return reply(res, 200, { ok: false, message: "Link your wallet first" });
            }
            const requesterLabel = userLabel(me);
            const usdPart = p.usdDisplay ? ` (${p.usdDisplay})` : "";
            const sentToPayer = await bot.api
              .sendMessage(
                p.payer.id,
                `💸 ${requesterLabel} requested ${p.amount} GRAM${usdPart} from you (testnet · no real value).\nValid for 5 minutes.`,
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
                usdDisplay: p.usdDisplay || "",
                usdRefNum: p.usdRefNum ?? null,
                label: requesterLabel,
                messageId: sentToPayer.message_id,
                since: Date.now(),
                status: "waiting",
              });
            }

            await bot.api
              .sendMessage(senderId, `📩 Sent payment request (${p.amount} GRAM${usdPart}, testnet) to ${p.label}.`)
              .catch(() => {});

            return reply(res, 200, {
              ok: true,
              type: "ask",
              message: "Request sent to\n" + p.label + "!",
            });
          }

          const promptText = p.coffeeCount
            ? `☕ Buy ${p.label} ${p.coffeeCount} ${p.coffeeCount > 1 ? "coffees" : "coffee"} (${p.amount} GRAM · ${p.usdDisplay}, testnet · no real value)?\nValid for 5 minutes.`
            : `Tip ${p.amount} GRAM${p.usdDisplay ? " (" + p.usdDisplay + ")" : ""} to ${p.label} (testnet · no real value)?\nValid for 5 minutes.`;

          const sent = await bot.api.sendMessage(senderId, promptText, {
            reply_markup: new InlineKeyboard().webApp("Review & sign", payLink(p.user, p.amount, id)),
          });
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
              usdDisplay: p.usdDisplay || "",
              usdRefNum: p.usdRefNum ?? null,
              coffeeCount: p.coffeeCount || 0,
              noteTag: p.noteTag || "",
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