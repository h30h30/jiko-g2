import crypto from "node:crypto";
import { Bot, Keyboard, InlineKeyboard } from "grammy";
import { startApi, watchPayment, createPairCode } from "./api.js";
import { PAGE, load, save, revokeUserSessions, short, payLink } from "./core.js";

const bot = new Bot(process.env.BOT_TOKEN);
let botUsername = "jikppay_bot";

// In-memory store for tips waiting on unregistered recipients (non-custodial, no funds moved)
const inviteDrafts = new Map();
const pendingInvites = [];

const walletKeyboard = (linked) =>
  new Keyboard().webApp(linked ? "Change wallet" : "Link wallet", PAGE + "/").resized();

const HELP =
  "How Jiko works 🐦\n\n" +
  "1) Link your wallet: /start, then tap the wallet button (testnet wallet via TON Connect).\n" +
  "2) Pair your G2 glasses: send /pair and enter the 6-digit code in the Jiko companion app.\n" +
  "3) Send a tip: /tip @username 1, or by voice from your G2 glasses.\n" +
  "4) Tap “Review & sign” and approve in your wallet.\n\n" +
  "Commands:\n" +
  "/start - link or change your wallet\n" +
  "/pair - get a code to connect your G2 glasses\n" +
  "/tip @user amount - send a tip (max 10 GRAM)\n" +
  "/wallet - show your linked wallet\n" +
  "/voicename Name - set the name friends say to the glasses\n" +
  "/unlink - remove your wallet from Jiko\n" +
  "/help - this message\n\n" +
  "Testnet only: no real money. Each tip signing request is valid for 5 minutes.";

bot.catch((err) => console.error("BOT ERROR:", err));

bot.command("start", async (ctx) => {
  const db = load();
  const me = db[ctx.from.id];
  if (me) {
    me.username = ctx.from.username ?? null;
    me.first_name = ctx.from.first_name ?? null;
    save(db);
    return ctx.reply(
      "Welcome back! 🐦\nYour wallet: " + short(me.address) +
        "\nSend /pair to connect your G2 glasses, /tip @username 1, or /help.",
      { reply_markup: walletKeyboard(true) }
    );
  }
  return ctx.reply(
    "Hi, I'm Jiko 🐦\n" +
      "I help you send crypto tips on TON (testnet demo) with one short command, " +
      "and by voice from your Even G2 glasses.\n\n" +
      "Tap the button below to link your wallet. For instructions, see /help.",
    { reply_markup: walletKeyboard(false) }
  );
});

bot.command("help", (ctx) => ctx.reply(HELP));

bot.command("wallet", (ctx) => {
  const me = load()[ctx.from.id];
  if (!me) return ctx.reply("No wallet linked yet. Use /start.");
  return ctx.reply("Your linked wallet (testnet):\n" + me.address);
});

bot.command("pair", (ctx) => {
  const me = load()[ctx.from.id];
  if (!me?.address) return ctx.reply("Link your wallet first with /start.");
  const code = createPairCode(ctx.from.id);
  return ctx.reply(
    "Your G2 pairing code: " + code + "\n\n" +
      "Enter this 6-digit code in the Jiko companion app on your phone.\n" +
      "Valid for 5 minutes."
  );
});

bot.command("unlink", async (ctx) => {
  const db = load();
  if (!db[ctx.from.id]) return ctx.reply("No wallet linked.");
  delete db[ctx.from.id];
  save(db);
  revokeUserSessions(ctx.from.id);
  return ctx.reply("Wallet removed and glasses unpaired ✅", { reply_markup: walletKeyboard(false) });
});

bot.command("voicename", async (ctx) => {
  const name = (ctx.match ?? "").trim();
  const db = load();
  const me = db[ctx.from.id];
  if (!me) return ctx.reply("Link your wallet first with /start.");
  if (!name) {
    return ctx.reply(
      "Your voice name: " + (me.alias ?? "not set") +
        "\nPick something easy to say, e.g. /voicename Hessi\n" +
        "Then anyone can tell the glasses: send one gram to Hessi."
    );
  }
  if (name.length > 24 || !/[a-z]/i.test(name)) {
    return ctx.reply("Use a short name with English letters.");
  }
  me.alias = name;
  save(db);
  return ctx.reply("Voice name set: " + name + " ✅");
});

bot.command("tip", async (ctx) => {
  const [, rawUser, rawAmount] = ctx.message.text.trim().split(/\s+/);
  const username = (rawUser ?? "").replace(/^@/, "").toLowerCase();
  const amount = Number(rawAmount);
  if (!username || !(amount > 0) || amount > 10) {
    return ctx.reply("Usage: /tip @username 1  (max 10 GRAM, testnet)");
  }
  const db = load();
  const entry = Object.entries(db).find(
    ([, u]) => (u.username ?? "").toLowerCase() === username
  );
  if (!entry) {
    const draftId = crypto.randomBytes(4).toString("hex");
    inviteDrafts.set(draftId, {
      senderId: ctx.from.id,
      targetUsername: username,
      amount,
      exp: Date.now() + 600_000,
    });
    return ctx.reply(
      "@" + username + " hasn't linked a wallet yet.\n" +
        "Ask them to open https://t.me/" + botUsername + " and press /start.\n\n" +
        "No funds move yet — tap below to get notified as soon as they join.",
      {
        reply_markup: new InlineKeyboard().text(
          "🔔 Notify me when @" + username + " links (24h)",
          "wait:" + draftId
        ),
      }
    );
  }
  const target = { ...entry[1], id: entry[0] };
  const watchId = crypto.randomBytes(8).toString("hex");
  const msg = await ctx.reply(
    "Tip " + amount + " GRAM to @" + username + "?\nValid for 5 minutes.",
    { reply_markup: new InlineKeyboard().webApp("Review & sign", payLink(target, amount, watchId)) }
  );
  const me = db[ctx.from.id];
  if (me?.address) {
    watchPayment(
      {
        senderAddr: me.address,
        senderId: ctx.from.id,
        senderLabel: me.username ? "@" + me.username : me.first_name || "someone",
        recipientId: target.id,
        recipientAddr: target.address,
        nano: String(Math.round(amount * 1e9)),
        amount,
        label: "@" + username,
        messageId: msg.message_id,
      },
      watchId
    );
  } else {
    setTimeout(() => {
      bot.api
        .editMessageText(msg.chat.id, msg.message_id, "⌛ Tip request expired. Send /tip again.")
        .catch(() => {});
    }, 300_000);
  }
});

bot.callbackQuery(/^wait:(.+)$/, async (ctx) => {
  const draftId = ctx.match[1];
  const draft = inviteDrafts.get(draftId);
  inviteDrafts.delete(draftId);
  await ctx.answerCallbackQuery();
  if (!draft || Date.now() > draft.exp) {
    return ctx.editMessageText("⌛ Invite prompt expired. Send /tip again.");
  }
  pendingInvites.push({
    senderId: draft.senderId,
    targetUsername: draft.targetUsername,
    amount: draft.amount,
    exp: Date.now() + 86_400_000, // 24 hours
  });
  return ctx.editMessageText(
    "⏳ Saved! When @" + draft.targetUsername + " links their wallet within 24h, " +
      "I'll send you the signing button for " + draft.amount + " GRAM.\n\n" +
      "Share this link with them:\nhttps://t.me/" + botUsername
  );
});

bot.on("message:web_app_data", async (ctx) => {
  try {
    const data = JSON.parse(ctx.message.web_app_data.data);
    const db = load();
    const existed = Boolean(db[ctx.from.id]);

    // Make sure user only links a Testnet wallet (chain -3)
    if (String(data.chain) !== "-3") {
      return ctx.reply(
        "⚠️ Please connect a TON Testnet wallet (not Mainnet).\n" +
          "Switch your wallet to Testnet and tap the button below again.",
        { reply_markup: walletKeyboard(existed) }
      );
    }

    const alias = db[ctx.from.id]?.alias;
    const savedUser = {
      username: ctx.from.username ?? null,
      first_name: ctx.from.first_name ?? null,
      alias,
      address: data.address,
      chain: data.chain,
    };
    db[ctx.from.id] = savedUser;
    save(db);
    await ctx.reply(
      (existed ? "Wallet updated ✅\n" : "Wallet linked ✅\n") + data.address +
        "\n\nSend /pair to connect your G2 glasses.",
      { reply_markup: walletKeyboard(true) }
    );

    // Notify any senders who were waiting for this user to link a wallet
    const uname = (savedUser.username ?? "").toLowerCase();
    if (uname) {
      const now = Date.now();
      for (let i = pendingInvites.length - 1; i >= 0; i--) {
        const inv = pendingInvites[i];
        if (now > inv.exp) {
          pendingInvites.splice(i, 1);
          continue;
        }
        if (inv.targetUsername !== uname) continue;
        pendingInvites.splice(i, 1);

        const target = { ...savedUser, id: String(ctx.from.id) };
        const watchId = crypto.randomBytes(8).toString("hex");
        const sent = await bot.api
          .sendMessage(
            inv.senderId,
            "🎉 @" + uname + " just linked their wallet!\n" +
              "Ready to send your " + inv.amount + " GRAM tip? (Valid for 5 minutes)",
            {
              reply_markup: new InlineKeyboard().webApp(
                "Review & sign",
                payLink(target, inv.amount, watchId)
              ),
            }
          )
          .catch(() => null);

        const sender = db[inv.senderId];
        if (sent && sender?.address) {
          watchPayment(
            {
              senderAddr: sender.address,
              senderId: inv.senderId,
              senderLabel: sender.username ? "@" + sender.username : sender.first_name || "someone",
              recipientId: target.id,
              recipientAddr: target.address,
              nano: String(Math.round(inv.amount * 1e9)),
              amount: inv.amount,
              label: "@" + uname,
              messageId: sent.message_id,
            },
            watchId
          );
        }
      }
    }
  } catch (e) {
    console.error(e);
    await ctx.reply("Could not save the wallet.");
  }
});

startApi(bot);

bot.start({
  onStart: async (info) => {
    botUsername = info.username;
    console.log("started as @" + info.username);
    await bot.api.setMyCommands([
      { command: "start", description: "Link or change your wallet" },
      { command: "pair", description: "Connect your Even G2 glasses" },
      { command: "tip", description: "Send a tip: /tip @username 1" },
      { command: "help", description: "Instructions" },
      { command: "wallet", description: "Show your linked wallet" },
      { command: "voicename", description: "Set the name used by voice" },
      { command: "unlink", description: "Remove your wallet" },
    ]);
    await bot.api.setMyShortDescription("Send crypto tips on TON with one short command, or by voice from G2 glasses.");
    await bot.api.setMyDescription(
      "Jiko helps you send crypto tips on TON (testnet demo) with one short command, or by voice from your Even G2 glasses. Tap Start to link your wallet."
    );
  },
});