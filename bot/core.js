import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;

export const PAGE = "https://h30h30.github.io/jiko-g2";
const FILE = "registry.json";
const SESSIONS_FILE = "sessions.json";

let botUsername = "jikopay_bot";
export const getBotUsername = () => botUsername;
export const setBotUsername = (name) => {
  if (name) botUsername = name;
};

// Persistent storage layer: Postgres (Neon/Render) with write-through cache & JSON fallback
let pool = null;
let dbReady = false;
let registryCache = {};
let sessionsCache = {};
let writeChain = Promise.resolve();

export const isDbEnabled = () => dbReady;

function loadJsonFile(path) {
  try {
    return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

export async function initStorage() {
  const dbUrl = (process.env.DATABASE_URL || "").trim();
  if (!dbUrl) {
    registryCache = loadJsonFile(FILE);
    sessionsCache = loadJsonFile(SESSIONS_FILE);
    console.log("[STORAGE] Local JSON mode (set DATABASE_URL for Postgres)");
    return;
  }

  pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => {
    console.error("[STORAGE] Postgres idle pool error:", err.message);
  });

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS jiko_kv (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())"
      );
      const { rows } = await pool.query(
        "SELECT k, v FROM jiko_kv WHERE k IN ('registry', 'sessions')"
      );
      for (const row of rows) {
        if (row.k === "registry" && row.v && typeof row.v === "object") registryCache = row.v;
        if (row.k === "sessions" && row.v && typeof row.v === "object") sessionsCache = row.v;
      }
      dbReady = true;
      console.log(
        `[STORAGE] Postgres ready (${Object.keys(registryCache).length} users, ${Object.keys(sessionsCache).length} sessions)`
      );
      return;
    } catch (e) {
      lastErr = e;
      console.error(`[STORAGE] Postgres init attempt ${attempt}/3 failed:`, e.message);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  console.error("[STORAGE] Falling back to local JSON after Postgres error:", lastErr?.message);
  pool = null;
  dbReady = false;
  registryCache = loadJsonFile(FILE);
  sessionsCache = loadJsonFile(SESSIONS_FILE);
}

function persistKey(key, data, fallbackFile) {
  if (pool && dbReady) {
    const payload = JSON.stringify(data);
    writeChain = writeChain
      .then(() =>
        pool.query(
          "INSERT INTO jiko_kv (k, v, updated_at) VALUES ($1, $2::jsonb, NOW()) " +
            "ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = NOW()",
          [key, payload]
        )
      )
      .catch((e) => console.error(`[STORAGE] Failed to persist ${key}:`, e.message));
    return;
  }
  try {
    fs.writeFileSync(fallbackFile, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`[STORAGE] File write error (${fallbackFile}):`, e.message);
  }
}

export const load = () => registryCache;
export const save = (d) => {
  registryCache = d;
  persistKey("registry", d, FILE);
};

export const loadSessions = () => sessionsCache;
export const saveSessions = (d) => {
  sessionsCache = d;
  persistKey("sessions", d, SESSIONS_FILE);
};

export function isNotionAllowed(userId, userRecord) {
  const raw = (process.env.NOTION_ALLOWED_USERS || "").trim();
  if (!raw) return true;
  const allowList = raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  const uid = String(userId ?? "");
  const uname = (userRecord?.username || "").toLowerCase();
  return allowList.includes(uid) || (Boolean(uname) && allowList.includes(uname));
}

// Two-way G2 <-> Telegram messaging (raw text only, zero AI on incoming replies)
const replyRoutes = new Map(); // botMessageId -> { recipientId, senderId, senderLabel, exp }
const lastReplyTarget = new Map(); // recipientId -> { senderId, senderLabel, exp }
const glassesInbox = new Map(); // glassesUserId -> [{ from, fromId, text, at }]
const lastInboxSender = new Map(); // glassesUserId -> { fromId, fromLabel, exp }

export function registerReplyRoute(botMessageId, recipientId, senderId, senderLabel) {
  const exp = Date.now() + 86_400_000;
  const entry = {
    recipientId: String(recipientId),
    senderId: String(senderId),
    senderLabel,
    exp,
  };
  if (botMessageId) replyRoutes.set(String(botMessageId), entry);
  lastReplyTarget.set(String(recipientId), entry);
}

export function findReplyRoute(botMessageId) {
  const key = String(botMessageId ?? "");
  const entry = replyRoutes.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    replyRoutes.delete(key);
    return null;
  }
  return entry;
}

export function getLastReplyTarget(recipientId) {
  const key = String(recipientId ?? "");
  const entry = lastReplyTarget.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    lastReplyTarget.delete(key);
    return null;
  }
  return entry;
}

export function pushInboxMessage(targetUserId, fromLabel, text, fromId) {
  const key = String(targetUserId);
  const cleanText = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!cleanText) return;
  const q = glassesInbox.get(key) || [];
  q.push({ from: fromLabel, fromId: String(fromId), text: cleanText, at: Date.now() });
  if (q.length > 10) q.shift();
  glassesInbox.set(key, q);
  lastInboxSender.set(key, {
    fromId: String(fromId),
    fromLabel,
    exp: Date.now() + 86_400_000,
  });
}

export function popInboxMessage(userId) {
  const key = String(userId);
  const q = glassesInbox.get(key);
  if (!q || !q.length) return null;
  return q.shift();
}

export function getLastInboxSender(userId) {
  const key = String(userId);
  const entry = lastInboxSender.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) {
    lastInboxSender.delete(key);
    return null;
  }
  return entry;
}

const inviteDrafts = new Map();
const pendingInvites = [];

export function createInviteDraft(senderId, targetUsername, amount, coffeeCount = 0) {
  const draftId = crypto.randomBytes(4).toString("hex");
  inviteDrafts.set(draftId, {
    senderId: String(senderId),
    targetUsername: targetUsername.toLowerCase().replace(/^@/, ""),
    amount,
    coffeeCount: Number(coffeeCount) || 0,
    exp: Date.now() + 600_000,
  });
  return draftId;
}

export function consumeInviteDraft(draftId) {
  const draft = inviteDrafts.get(draftId);
  inviteDrafts.delete(draftId);
  if (!draft || Date.now() > draft.exp) return null;
  return draft;
}

export function addPendingInvite(senderId, targetUsername, amount) {
  pendingInvites.push({
    senderId: String(senderId),
    targetUsername: targetUsername.toLowerCase().replace(/^@/, ""),
    amount,
    exp: Date.now() + 86_400_000,
  });
}

export function popPendingInvitesFor(username) {
  const uname = (username ?? "").toLowerCase().replace(/^@/, "");
  if (!uname) return [];
  const now = Date.now();
  const matched = [];
  for (let i = pendingInvites.length - 1; i >= 0; i--) {
    const inv = pendingInvites[i];
    if (now > inv.exp) {
      pendingInvites.splice(i, 1);
      continue;
    }
    if (inv.targetUsername === uname) {
      matched.push(inv);
      pendingInvites.splice(i, 1);
    }
  }
  return matched;
}

export function inviteShareUrl(coffeeCount = 0) {
  const botUrl = "https://t.me/" + getBotUsername();
  const text = coffeeCount
    ? `Hey! I'd like to buy you ${coffeeCount > 1 ? coffeeCount + " coffees" : "a coffee"} on Jiko ☕ Open the bot and link your TON testnet wallet so I can send it over.`
    : "Hey! I have a small tip for you on Jiko 🎁 Open the bot and link your TON testnet wallet so I can send it over.";
  return (
    "https://t.me/share/url?url=" +
    encodeURIComponent(botUrl) +
    "&text=" +
    encodeURIComponent(text)
  );
}

export function revokeUserSessions(userId) {
  const sessions = loadSessions();
  let changed = false;
  for (const [token, uid] of Object.entries(sessions)) {
    if (String(uid) === String(userId)) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) saveSessions(sessions);
}

export const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

export function canonicalAddr(addr) {
  if (!addr || typeof addr !== "string") return "";
  const s = addr.trim();
  if (s.includes(":")) {
    const [wc, hash] = s.split(":");
    return `${Number(wc)}:${(hash ?? "").toLowerCase()}`;
  }
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(b64, "base64");
    if (buf.length !== 36) return s;
    return `${buf.readInt8(1)}:${buf.subarray(2, 34).toString("hex")}`;
  } catch {
    return s;
  }
}

const NUM = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  half: 0.5,
};

function extractAmount(str) {
  const d = str.match(/\d+(\.\d+)?/);
  if (d) return Number(d[0]);
  for (const w of str.split(" ")) {
    if (Object.hasOwn(NUM, w)) return NUM[w];
  }
  return null;
}

const isUsdText = (str) => /\$|\b(usd|dollars?|bucks?)\b/i.test(str);

// Deterministic fallback parser
export function parseCommand(text) {
  const raw = (text ?? "").trim();
  const t = raw.toLowerCase().replace(/[^a-z0-9.$@_\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;

  // 1) Save note to Notion
  const noteMatch = raw.match(/^(?:take a note|save a note|add a note|note|remember to|remind me to)\s*[:,-]?\s+(.+)$/i);
  if (noteMatch && noteMatch[1].trim()) {
    return { type: "note", content: noteMatch[1].trim() };
  }

  // 2) Smart Notion summary / spending report
  if (
    /\b(summarize|summary|analyze|report)\b.*\b(notes?|notion|log|spending|expenses?|tips?|coffees?)\b/.test(t) ||
    /\bhow much\b.*\b(spend|spent|tip|tipped|sent)\b/.test(t) ||
    /\btotal\b.*\b(spent|spending|tips?|expenses?)\b/.test(t)
  ) {
    return { type: "notion_summary", question: raw };
  }

  // 3) Read recent Notion notes
  if (/\b(show|read|list|check|my)\b.*\b(notes?|notion)\b/.test(t)) {
    return { type: "notes" };
  }

  // 4) Live TON/USD reference rate
  if (
    /\b(ton|toncoin)\b.*\b(price|rate|worth|usd|dollars?)\b/.test(t) ||
    /\b(price|rate)\b.*\b(ton|toncoin)\b/.test(t)
  ) {
    return { type: "price" };
  }

  // 5) Telegram quick message / reply
  const tellMatch = raw.match(/^(?:tell|message|text)\s+@?([a-z0-9_]+)\s+(?:that\s+)?(.+)$/i);
  if (tellMatch && tellMatch[2].trim()) {
    return { type: "message", name: tellMatch[1], body: tellMatch[2].trim() };
  }
  const replyToMatch = raw.match(/^reply\s+to\s+@?([a-z0-9_]+)\s*[:,-]?\s+(.+)$/i);
  if (replyToMatch && replyToMatch[2].trim()) {
    return { type: "message", name: replyToMatch[1], body: replyToMatch[2].trim() };
  }
  const replyOnlyMatch = raw.match(/^reply\s*[:,-]?\s+(.+)$/i);
  if (replyOnlyMatch && replyOnlyMatch[1].trim()) {
    return { type: "message", name: "", body: replyOnlyMatch[1].trim() };
  }

  // 6) Buy someone a coffee
  const coffeeA = t.match(/\b(?:buy|get|treat|send)\s+@?([a-z0-9_]+)\s+(a|an|one|two|three|four|five|\d+)\s+coffees?\b/);
  if (coffeeA) {
    const count = Math.round(extractAmount(coffeeA[2]) || 1);
    if (count > 0) return { type: "coffee", count, name: coffeeA[1] };
  }
  const coffeeB = t.match(/\b(?:buy|get|send)\s+(a|an|one|two|three|four|five|\d+)\s+coffees?\s+(?:for|to)\s+@?([a-z0-9_]+)/);
  if (coffeeB) {
    const count = Math.round(extractAmount(coffeeB[1]) || 1);
    if (count > 0) return { type: "coffee", count, name: coffeeB[2] };
  }

  // 7) Payment request (TON/GRAM or USD)
  const askMatch = t.match(/\b(?:ask|request)\s+@?([a-z0-9_]+)\s+(?:for|to send|to pay)\s+(.+)$/);
  if (askMatch) {
    const amount = extractAmount(askMatch[2]);
    if (amount > 0) {
      return { type: "ask", amount, unit: isUsdText(askMatch[2]) ? "usd" : "gram", name: askMatch[1] };
    }
  }
  const reqFromMatch = t.match(/\b(?:ask|request)\s+(.+?)\s+from\s+@?([a-z0-9_]+)$/);
  if (reqFromMatch) {
    const amount = extractAmount(reqFromMatch[1]);
    if (amount > 0) {
      return { type: "ask", amount, unit: isUsdText(reqFromMatch[1]) ? "usd" : "gram", name: reqFromMatch[2] };
    }
  }

  // 8) Tip command: "send 1 ton/gram to Alex" OR "send Alex 1 ton/gram"
  const i = t.lastIndexOf(" to ");
  if (i >= 0) {
    const left = t.slice(0, i);
    const name = t.slice(i + 4).replace(/^@/, "").replace(/\.+$/, "").trim();
    if (/\b(send|tip|give|pay)\b/.test(left) && name) {
      const amount = extractAmount(left);
      if (amount > 0) {
        return { type: "tip", amount, unit: isUsdText(left) ? "usd" : "gram", name };
      }
    }
  }
  const directTip = t.match(/^(?:send|tip|give|pay)\s+@?([a-z0-9_]+)\s+(.+)$/);
  if (directTip) {
    const amount = extractAmount(directTip[2]);
    if (amount > 0) {
      return { type: "tip", amount, unit: isUsdText(directTip[2]) ? "usd" : "gram", name: directTip[1] };
    }
  }

  // 9) Recent transactions
  if (
    !/\b(send|tip|give|pay|ask|request|buy)\b/.test(t) &&
    /\b(transactions?|history|recent|activity|payments?|tips?)\b/.test(t)
  ) {
    return { type: "history" };
  }

  // 10) Wallet balance
  if (
    !/\b(send|tip|give|pay|ask|request|buy)\b/.test(t) &&
    (/\b(balance|wallet)\b/.test(t) || /\bhow (much|many)\b/.test(t))
  ) {
    return { type: "balance" };
  }

  return null;
}

function lev(a, b) {
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return m[a.length][b.length];
}

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b" };
const norm = (s) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[0-9]/g, (d) => LEET[d] ?? "")
    .replace(/[^a-z]/g, "");

function phonetic(s) {
  return norm(s)
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/q/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/y/g, "i")
    .replace(/([a-z])\1+/g, "$1")
    .replace(/[aeiou]+/g, "a");
}

export function findRecipient(name) {
  const q = norm(name);
  const pq = phonetic(name);
  if (!q) return null;
  const scored = [];
  for (const [id, u] of Object.entries(load())) {
    let best = Infinity;
    for (const cand of [u.alias, u.username, u.first_name]) {
      const c = norm(cand);
      if (!c) continue;
      const pc = phonetic(cand);
      let d = lev(c, q);
      if (pq.length >= 3 && pc === pq) d = Math.min(d, 0.25);
      else if (c.length >= 3 && q.length >= 3 && (c.includes(q) || q.includes(c))) d = Math.min(d, 0.5);
      else if (pq.length >= 4 && pc.length >= 4 && lev(pc, pq) <= 1) d = Math.min(d, 0.75);
      best = Math.min(best, d);
    }
    scored.push({ d: best, user: { ...u, id } });
  }
  scored.sort((a, b) => a.d - b.d);
  const limit = Math.max(1, Math.floor(q.length / 4));
  if (!scored.length || scored[0].d > limit) return null;
  if (scored[1] && scored[1].d === scored[0].d) return { ambiguous: true };
  return scored[0].user;
}

export function payLink(user, amount, watchId = "") {
  const rid = watchId || crypto.randomBytes(8).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + 300;
  const name = user.username ?? user.first_name ?? "friend";
  let url =
    PAGE + "/pay.html?to=" + encodeURIComponent(user.address) +
    "&amount=" + amount + "&name=" + encodeURIComponent(name) +
    "&r=" + rid + "&exp=" + exp;
  const api = (process.env.PUBLIC_API_URL || "").trim().replace(/\/$/, "");
  if (api && watchId) {
    url += "&wid=" + encodeURIComponent(watchId) + "&api=" + encodeURIComponent(api);
  }
  return url;
}