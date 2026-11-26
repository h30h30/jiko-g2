import fs from "node:fs";
import crypto from "node:crypto";

export const PAGE = "https://h30h30.github.io/jiko-g2";
const FILE = "registry.json";
const SESSIONS_FILE = "sessions.json";

let botUsername = "jikopay_bot";
export const getBotUsername = () => botUsername;
export const setBotUsername = (name) => {
  if (name) botUsername = name;
};

const inviteDrafts = new Map();
const pendingInvites = [];

export function createInviteDraft(senderId, targetUsername, amount) {
  const draftId = crypto.randomBytes(4).toString("hex");
  inviteDrafts.set(draftId, {
    senderId: String(senderId),
    targetUsername: targetUsername.toLowerCase().replace(/^@/, ""),
    amount,
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

export const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {});
export const save = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));

export const loadSessions = () =>
  fs.existsSync(SESSIONS_FILE) ? JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) : {};
export const saveSessions = (d) => fs.writeFileSync(SESSIONS_FILE, JSON.stringify(d, null, 2));

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

  // 4) Live TON/USD price
  if (
    /\b(ton|toncoin)\b.*\b(price|rate|worth|usd|dollars?)\b/.test(t) ||
    /\b(price|rate)\b.*\b(ton|toncoin)\b/.test(t)
  ) {
    return { type: "price" };
  }

  // 5) Buy someone a coffee: "buy Hessi a coffee" / "buy 2 coffees for Hessi"
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

  // 6) Payment request (GRAM or USD)
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

  // 7) Tip command (GRAM or USD)
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

  // 8) Recent transactions (still available by voice)
  if (
    !/\b(send|tip|give|pay|ask|request|buy)\b/.test(t) &&
    /\b(transactions?|history|recent|activity|payments?|tips?)\b/.test(t)
  ) {
    return { type: "history" };
  }

  // 9) Wallet balance
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

export function findRecipient(name) {
  const q = norm(name);
  if (!q) return null;
  const scored = [];
  for (const [id, u] of Object.entries(load())) {
    let best = Infinity;
    for (const cand of [u.alias, u.username, u.first_name]) {
      const c = norm(cand);
      if (!c) continue;
      let d = lev(c, q);
      if (c.length >= 3 && q.length >= 3 && (c.includes(q) || q.includes(c))) d = Math.min(d, 0.5);
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