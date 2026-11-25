import http from "node:http";
import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";
import { parseCommand, findRecipient, payLink, load } from "./core.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const TONCENTER = "https://testnet.toncenter.com/api/v2/getTransactions";
const pending = new Map();
const watching = new Map();

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
  return (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
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
      const r = await fetch(TONCENTER + "?address=" + encodeURIComponent(w.senderAddr) + "&limit=10");
      const json = await r.json();
      const found = (json.result ?? []).some(
        (tx) =>
          tx.utime >= Math.floor(w.since / 1000) - 5 &&
          (tx.out_msgs ?? []).some((m) => String(m.value) === w.nano)
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

// used by the /tip command in bot.js
export function watchPayment(w) {
  const id = crypto.randomBytes(4).toString("hex");
  watching.set(id, { ...w, since: Date.now(), status: "waiting" });
  return id;
}

export function startApi(bot, port = 8787) {
  setInterval(() => checkWatches(bot), 4000);

  http
    .createServer(async (req, res) => {
      cors(res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method !== "POST") {
        res.writeHead(404);
        return res.end();
      }
      try {
        if (req.url === "/voice") {
          const pcm = await readBody(req, 3_000_000);
          return reply(res, 200, { text: await transcribe(pcm) });
        }

        if (req.url === "/command") {
          const { text } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
          const cmd = parseCommand(text ?? "");
          if (!cmd) {
            return reply(res, 200, { ok: false, message: "Didn't get that.\nTry: send 1 gram to Alex" });
          }
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
          const id = crypto.randomBytes(4).toString("hex");
          const label = user.username ? "@" + user.username : user.first_name || cmd.name;
          pending.set(id, { user, amount: cmd.amount, label, at: Date.now() });
          return reply(res, 200, {
            ok: true,
            id,
            summary: "Send " + cmd.amount + " GRAM to\n" + label + "?",
          });
        }

        if (req.url === "/confirm") {
          const { id } = JSON.parse((await readBody(req, 10_000)).toString() || "{}");
          const p = pending.get(id);
          pending.delete(id);
          if (!p || Date.now() - p.at > 60_000) return reply(res, 200, { ok: false, message: "Expired" });
          const senderId = process.env.DEV_USER_ID;
          if (!senderId) return reply(res, 200, { ok: false, message: "Set DEV_USER_ID in .env" });
          const sent = await bot.api.sendMessage(
            senderId,
            "Tip " + p.amount + " GRAM to " + p.label + "?\nValid for 5 minutes.",
            { reply_markup: new InlineKeyboard().webApp("Review & sign", payLink(p.user, p.amount)) }
          );
          const me = load()[senderId];
          if (me?.address) {
            watching.set(id, {
              senderAddr: me.address,
              senderId,
              senderLabel: me.username ? "@" + me.username : me.first_name || "someone",
              recipientId: p.user.id,
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
          return reply(res, 200, {
            status: w?.status ?? "unknown",
            amount: w?.amount,
            label: w?.label,
          });
        }

        res.writeHead(404);
        res.end();
      } catch (e) {
        console.error("API ERROR:", e.message);
        reply(res, 500, { error: String(e.message) });
      }
    })
    .listen(port, "127.0.0.1", () => console.log("API on http://127.0.0.1:" + port));
}