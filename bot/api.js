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
} from "./core.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
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
  const t0 = Date.now();
  const wav = wavFromPcm(pcm);
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: "Transcribe this audio exactly. Reply with only the transcript. If there is no speech, reply with an empty string.",
            },
            { inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error("Gemini " + res.status + ": " + (await res.text()).slice(0, 200));
  const json = await res.json();
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  console.log(
    `[TIMING] Gemini STT: ${((Date.now() - t0) / 1000).toFixed(2)}s (${(pcm.length / 32000).toFixed(1)}s audio)`
  );
  return text;
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

// edits the original "Review & sign" message if we have it, otherwise sends a new one
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
        "⌛ Not completed: no transaction was seen. It was cancelled, rejected or not signed in time. Send it again if you still want to."
      );
      continue;
    }
    try {
      const r = await fetch(TONCENTER_TX + "?address=" + encodeURIComponent(w.senderAddr) + "&limit=10");
      const json = await r.json();
      const targetCanon = canonicalAddr(w.recipientAddr);
      const found = (json.result ?? []).some(
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
      await notify(bot, w, "✅ Sent " + w.amount + " GRAM to " + w.label + " (testnet).");
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

// used by /pair in bot.js
export function createPairCode(userId) {
  const now = Date.now();
  for (const [k, v] of pairCodes) {
    if (now > v.exp) pairCodes.delete(k);
  }
  const code = String(crypto.randomInt(100000, 1000000));
  pairCodes.set(code, { userId: String(userId), exp: now + 300_000 });
  return code;
}

// used by /tip and pending invites in bot.js
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
        return reply(res, 200, { ok: true, service: "jiko" });
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
            await notify(bot, w, "❌ Tip cancelled in wallet.");
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
          return reply(res, 200, {
            ok: true,
            token,
            label: userLabel(me),
            wallet: short(me.address),
          });
        }

        if (req.url === "/me") {
          const senderId = getAuthUserId(req);
          if (!senderId) return reply(res, 401, { ok: false, error: "Not paired" });
          const me = load()[senderId];
          if (!me?.address) return reply(res, 401, { ok: false, error: "Wallet unlinked" });
          return reply(res, 200, {
            ok: true,
            label: userLabel(me),
            wallet: short(me.address),
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

        // All endpoints below require a paired glasses session
        const senderId = getAuthUserId(req);
        if (!senderId) {
          return reply(res, 401, { ok: false, error: "Not paired" });
        }

        if (req.url === "/voice") {
          const pcm = await readBody(req, 3_000_000);
          return reply(res, 200, { text: await transcribe(pcm) });
        }

        if (req.url === "/command") {
          const { text } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
          const cmd = parseCommand(text ?? "");
          if (!cmd) {
            return reply(res, 200, {
              ok: false,
              message: "Didn't get that.\nTry: send 1 gram to Alex\nor: check balance",
            });
          }

          // Balance check (100% hands-free, no phone needed)
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
            return reply(res, 200, { ok: false, message: 'No linked wallet for\n"' + cmd.name + '"' });
          }
          const id = crypto.randomBytes(8).toString("hex");
          const label = user.username ? "@" + user.username : user.first_name || cmd.name;
          pending.set(id, { senderId, user, amount: cmd.amount, label, at: Date.now() });
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
          return reply(res, 200, { ok: true });
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