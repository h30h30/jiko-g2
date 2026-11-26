import crypto from "node:crypto";
import { Bot, Keyboard, InlineKeyboard } from "grammy";
import { startApi, watchPayment, createPairCode, fetchTonPriceUsd, getUserCoffeeUsd } from "./api.js";
import {
  PAGE,
  initStorage,
  isNotionAllowed,
  load,
  save,
  revokeUserSessions,
  short,
  payLink,
  inviteShareUrl,
  setBotUsername,
  createInviteDraft,
  consumeInviteDraft,
  addPendingInvite,
  popPendingInvitesFor,
} from "./core.js";
import { isNotionEnabled, saveNotionEntry } from "./notion.js";

const bot = new Bot(process.env.BOT_TOKEN);

const walletKeyboard = (linked) =>
  new Keyboard().webApp(linked ? "Change wallet" : "Link wallet", PAGE + "/").resized();

const HELP =
  "How Jiko works 🐦\n\n" +
  "1) Link your wallet: /start, then tap the wallet button (TON Testnet via TON Connect).\n" +
  "2) Pair your G2 glasses: send /pair and enter the 6-digit code in the Jiko companion app.\n" +
  "3) Speak naturally to your G2 glasses:\n" +
  "   • \"buy Alex a coffee\" (converted via live TON/USD mainnet ref rate)\n" +
  "   • \"send $5 to Alex\" or \"send 1 TON to Alex\"\n" +
  "   • \"ask Alex for $3\" or \"what is TON price?\"\n" +
  "   • \"note: send pitch deck tomorrow\" (saves to demo Notion log)\n" +
  "   • \"summarize my Notion notes\" or \"how much did I spend?\"\n" +
  "   • Up/Down: flip 4 HUD cards · Double-tap: sync / cancel\n\n" +
  "Commands:\n" +
  "/start - link or change your wallet\n" +
  "/pair - get a code to connect your G2 glasses\n" +
  "/price - live TON/USD mainnet ref & coffee rate\n" +
  "/coffee amount - set your coffee reference price in USD (default $5)\n" +
  "/tip @user amount - send a testnet tip (max 25 GRAM)\n" +
  "/ask @user amount - request testnet GRAM from a friend\n" +
  "/note text - save a quick note to the demo Notion log\n" +
  "/wallet - show your linked wallet\n" +
  "/voicename Name - opt-in voice alias for speech recognition (/voicename clear to remove)\n" +
  "/unlink - remove your wallet and unpair glasses\n" +
  "/help - this message\n\n" +
  "Testnet only (no real value). Non-custodial: every transfer requires your wallet signature within 5 minutes.";

bot.catch((err) => console.error("BOT ERROR:", err));

bot.command("start", async (ctx) => {
  const db = load();
  const me = db[ctx.from.id];
  if (me) {
    me.username = ctx.from.username ?? null;
    me.first_name = ctx.from.first_name ?? null;
    save(db);
    return ctx.reply(
      "Welcome back! 🐦\nYour wallet: " + short(me.address) + " (testnet)\n" +
        "Send /pair to connect your G2 glasses, /price for TON/USD ref rate, /coffee to set coffee price, or /help.",
      { reply_markup: walletKeyboard(true) }
    );
  }
  return ctx.reply(
    "Hi, I'm Jiko 🐦\n" +
      "Your AI voice assistant, Notion workspace logger & non-custodial TON testnet tip wallet on Even G2 glasses.\n\n" +
      "Tap the button below to link your testnet wallet. For instructions, see /help.",
    { reply_markup: walletKeyboard(false) }
  );
});

bot.command("help", (ctx) => ctx.reply(HELP));

bot.command("price", async (ctx) => {
  try {
    const price = await fetchTonPriceUsd(true);
    const coffeeUsd = getUserCoffeeUsd(ctx.from.id);
    const coffeeGram = Math.max(0.01, Number((coffeeUsd / price).toFixed(2)));
    return ctx.reply(
      `📈 Live TON/USD (mainnet ref): $${price.toFixed(2)}\n` +
        `☕ 1 Coffee ($${coffeeUsd} ref) ≈ ${coffeeGram} GRAM\n` +
        "ℹ️ Testnet tokens have no real monetary value."
    );
  } catch {
    return ctx.reply("Could not fetch live TON/USD reference rate right now. Try again in a moment.");
  }
});

bot.command("wallet", (ctx) => {
  const me = load()[ctx.from.id];
  if (!me) return ctx.reply("No wallet linked yet. Use /start.");
  return ctx.reply("Your linked wallet (TON Testnet · no real value):\n" + me.address);
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
      "Your opt-in voice name: " + (me.alias ?? "not set") + "\n\n" +
        "Privacy note: Only opt-in voice names set here are shared with speech recognition (Groq) to improve spoken name accuracy. Telegram usernames are never sent.\n\n" +
        "Set: /voicename Alex\n" +
        "Remove: /voicename clear"
    );
  }
  if (/^(clear|off|none|remove)$/i.test(name)) {
    delete me.alias;
    save(db);
    return ctx.reply("Voice name removed ✅ Your name will not be sent to speech recognition.");
  }
  if (name.length > 24 || !/[a-z]/i.test(name)) {
    return ctx.reply("Use a short name with English letters (or /voicename clear to remove).");
  }
  me.alias = name;
  save(db);
  return ctx.reply(
    "Voice name set: " + name + " ✅\n" +
      "This alias will be used to improve voice recognition. Use /voicename clear anytime to opt out."
  );
});

bot.command("coffee", async (ctx) => {
  const raw = (ctx.match ?? "").trim().replace(/^\$/, "");
  const db = load();
  const me = db[ctx.from.id];
  if (!me) return ctx.reply("Link your wallet first with /start.");
  if (!raw) {
    const current = getUserCoffeeUsd(ctx.from.id);
    return ctx.reply(
      `☕ Your coffee reference price: $${current} (converted via live TON/USD mainnet ref rate)\n` +
        "Change it anytime, e.g. /coffee 3.5"
    );
  }
  const price = Number(raw);
  if (!Number.isFinite(price) || price < 0.5 || price > 50) {
    return ctx.reply("Enter a valid USD amount between 0.5 and 50 (e.g. /coffee 3).");
  }
  me.coffeeUsd = Number(price.toFixed(2));
  save(db);
  return ctx.reply(`☕ Coffee reference price set to $${me.coffeeUsd} ✅`);
});

bot.command("note", async (ctx) => {
  const text = (ctx.match ?? "").trim();
  if (!text) return ctx.reply("Usage: /note Send pitch deck to Alex tomorrow");
  if (!isNotionEnabled()) {
    return ctx.reply("Notion is not configured on the server yet.");
  }
  const me = load()[ctx.from.id];
  if (!isNotionAllowed(ctx.from.id, me)) {
    return ctx.reply("The shared demo Notion workspace is currently restricted to demo accounts.");
  }
  try {
    const author = ctx.from.username ? "@" + ctx.from.username : ctx.from.first_name || "user";
    await saveNotionEntry({
      kind: "note",
      title: text,
      details: `Saved from Telegram by ${author}`,
    });
    return ctx.reply("📒 Saved to demo Notion log ✅\n" + text);
  } catch (e) {
    console.error("TELEGRAM NOTE ERROR:", e.message);
    return ctx.reply("Could not save to Notion. Check your database connection.");
  }
});

bot.command("ask", async (ctx) => {
  const [, rawUser, rawAmount] = ctx.message.text.trim().split(/\s+/);
  const username = (rawUser ?? "").replace(/^@/, "").toLowerCase();
  const amount = Number(rawAmount);
  if (!username || !(amount > 0) || amount > 25) {
    return ctx.reply("Usage: /ask @username 2  (max 25 GRAM, testnet)");
  }
  const db = load();
  const me = db[ctx.from.id];
  if (!me?.address) return ctx.reply("Link your wallet first with /start.");

  const entry = Object.entries(db).find(
    ([, u]) => (u.username ?? "").toLowerCase() === username
  );
  if (!entry) {
    return ctx.reply("@" + username + " hasn't linked a wallet yet.");
  }

  const payer = { ...entry[1], id: entry[0] };
  const requesterLabel = me.username ? "@" + me.username : me.first_name || "someone";
  const watchId = crypto.randomBytes(8).toString("hex");
  const sent = await bot.api
    .sendMessage(
      payer.id,
      "💸 " + requesterLabel + " requested " + amount + " GRAM from you (testnet · no real value).\nValid for 5 minutes.",
      {
        reply_markup: new InlineKeyboard().webApp(
          "Review & sign",
          payLink({ ...me, id: String(ctx.from.id) }, amount, watchId)
        ),
      }
    )
    .catch(() => null);

  if (!sent) return ctx.reply("Could not send request to @" + username + ".");

  if (payer.address) {
    watchPayment(
      {
        senderAddr: payer.address,
        senderId: payer.id,
        senderLabel: "@" + username,
        recipientId: ctx.from.id,
        recipientAddr: me.address,
        nano: String(Math.round(amount * 1e9)),
        amount,
        label: requesterLabel,
        messageId: sent.message_id,
      },
      watchId
    );
  }
  return ctx.reply("📩 Sent payment request (" + amount + " GRAM, testnet) to @" + username + ".");
});

bot.command("tip", async (ctx) => {
  const [, rawUser, rawAmount] = ctx.message.text.trim().split(/\s+/);
  const username = (rawUser ?? "").replace(/^@/, "").toLowerCase();
  const amount = Number(rawAmount);
  if (!username || !(amount > 0) || amount > 25) {
    return ctx.reply("Usage: /tip @username 1  (max 25 GRAM, testnet)");
  }
  const db = load();
  const entry = Object.entries(db).find(
    ([, u]) => (u.username ?? "").toLowerCase() === username
  );
  if (!entry) {
    const draftId = createInviteDraft(ctx.from.id, username, amount, 0);
    const kb = new InlineKeyboard()
      .url("🎁 Send invite to @" + username, inviteShareUrl(0))
      .row()
      .text("🔔 Notify me when @" + username + " joins (24h)", "wait:" + draftId);

    return ctx.reply(
      "@" + username + " hasn't linked a wallet yet.\n" +
        "Tap below to send them a ready-made invite message (no funds move until they join and you sign).",
      {
        reply_markup: kb,
        link_preview_options: { is_disabled: true },
      }
    );
  }
  const target = { ...entry[1], id: entry[0] };
  const watchId = crypto.randomBytes(8).toString("hex");
  const msg = await ctx.reply(
    "Tip " + amount + " GRAM to @" + username + " (testnet · no real value)?\nValid for 5 minutes.",
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
  const draft = consumeInviteDraft(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!draft) {
    return ctx.editMessageText("⌛ Invite prompt expired. Send /tip again.");
  }
  addPendingInvite(draft.senderId, draft.targetUsername, draft.amount);
  const kb = new InlineKeyboard().url(
    "🎁 Send invite to @" + draft.targetUsername,
    inviteShareUrl(draft.coffeeCount || 0)
  );
  return ctx.editMessageText(
    "⏳ Saved! When @" + draft.targetUsername + " links their wallet within 24h, " +
      "I'll send you the signing button for " + draft.amount + " GRAM.\n\n" +
      "Tap below to forward them the invite:",
    {
      reply_markup: kb,
      link_preview_options: { is_disabled: true },
    }
  );
});

bot.on("message:web_app_data", async (ctx) => {
  try {
    const data = JSON.parse(ctx.message.web_app_data.data);
    const db = load();
    const existed = Boolean(db[ctx.from.id]);

    if (String(data.chain) !== "-3") {
      return ctx.reply(
        "⚠️ Please connect a TON Testnet wallet (not Mainnet).\n" +
          "Switch your wallet to Testnet and tap the button below again.",
        { reply_markup: walletKeyboard(existed) }
      );
    }

    const alias = db[ctx.from.id]?.alias;
    const coffeeUsd = db[ctx.from.id]?.coffeeUsd;
    const savedUser = {
      username: ctx.from.username ?? null,
      first_name: ctx.from.first_name ?? null,
      alias,
      coffeeUsd,
      address: data.address,
      chain: data.chain,
    };
    db[ctx.from.id] = savedUser;
    save(db);

    const voiceHint = !alias
      ? "\n\n🎙 Optional: Set an opt-in voice alias with /voicename YourName so friends can buy you a coffee on G2."
      : "";

    await ctx.reply(
      (existed ? "Wallet updated ✅ (testnet)\n" : "Wallet linked ✅ (testnet)\n") +
        data.address +
        voiceHint +
        "\n\nSend /pair to connect your G2 glasses.",
      { reply_markup: walletKeyboard(true) }
    );

    const uname = (savedUser.username ?? "").toLowerCase();
    const matchedInvites = popPendingInvitesFor(uname);
    for (const inv of matchedInvites) {
      const target = { ...savedUser, id: String(ctx.from.id) };
      const watchId = crypto.randomBytes(8).toString("hex");
      const sent = await bot.api
        .sendMessage(
          inv.senderId,
          "🎉 @" + uname + " just linked their wallet!\n" +
            "Ready to send your " + inv.amount + " GRAM testnet tip? (Valid for 5 minutes)",
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
  } catch (e) {
    console.error(e);
    await ctx.reply("Could not save the wallet.");
  }
});

// Boot storage first, then start API and Telegram bot
await initStorage();
startApi(bot);

bot.start({
  onStart: async (info) => {
    setBotUsername(info.username);
    console.log("started as @" + info.username);
    await bot.api.setMyCommands([
      { command: "start", description: "Link or change your wallet" },
      { command: "pair", description: "Connect your Even G2 glasses" },
      { command: "price", description: "Live TON/USD ref & coffee rate" },
      { command: "coffee", description: "Set your coffee ref price in USD" },
      { command: "tip", description: "Send a testnet tip: /tip @username 1" },
      { command: "ask", description: "Request testnet GRAM: /ask @username 2" },
      { command: "note", description: "Save a note to demo Notion log" },
      { command: "help", description: "Instructions" },
      { command: "wallet", description: "Show your linked wallet" },
      { command: "voicename", description: "Opt-in voice name for G2" },
      { command: "unlink", description: "Remove wallet & unpair glasses" },
    ]);
    await bot.api.setMyShortDescription("AI voice assistant, Notion notes & TON testnet tips on Even G2 glasses.");
    await bot.api.setMyDescription(
      "Jiko is your AI voice assistant, Notion workspace logger, and non-custodial TON testnet tip wallet on Even G2 glasses. Tap Start to link your wallet."
    );
  },
});