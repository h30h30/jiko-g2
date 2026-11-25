import fs from "node:fs";
import crypto from "node:crypto";

export const PAGE = "https://h30h30.github.io/jiko-g2";
const FILE = "registry.json";
const SESSIONS_FILE = "sessions.json";

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

// Normalises TON addresses (EQ/UQ/kQ/0Q or raw 0:hex) so they can be compared reliably
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

const NUM = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5 };

// Parses either a tip command ("send one gram to Alex") or a balance check ("check my balance")
export function parseCommand(text) {
  const t = text.toLowerCase().replace(/[^a-z0-9.@_\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;

  // 1) Check for tip command
  const i = t.lastIndexOf(" to ");
  if (i >= 0) {
    const left = t.slice(0, i);
    const name = t.slice(i + 4).replace(/^@/, "").replace(/\.+$/, "").trim();
    if (/\b(send|tip|give|pay)\b/.test(left) && name) {
      let amount = null;
      const d = left.match(/\d+(\.\d+)?/);
      if (d) amount = Number(d[0]);
      else {
        for (const w of left.split(" ")) {
          if (Object.hasOwn(NUM, w)) { amount = NUM[w]; break; }
        }
      }
      if (amount > 0) return { type: "tip", amount, name };
    }
  }

  // 2) Check for wallet balance command
  if (
    !/\b(send|tip|give|pay)\b/.test(t) &&
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

// spoken-friendly: lowercase, leetspeak digits -> letters, drop everything else
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b" };
const norm = (s) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[0-9]/g, (d) => LEET[d] ?? "")
    .replace(/[^a-z]/g, "");

// finds a linked user by (approximate) voice name, username or first name
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