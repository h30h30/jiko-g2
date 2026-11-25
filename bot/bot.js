import { Bot, Keyboard, InlineKeyboard } from "grammy";
import { startApi, watchPayment } from "./api.js";
import { PAGE, load, save, short, payLink } from "./core.js";

const bot = new Bot(process.env.BOT_TOKEN);

const walletKeyboard = (linked) =>
  new Keyboard().webApp(linked ? "Change wallet" : "Link wallet", PAGE + "/").resized();

const HELP =
  "How Jiko works 🐦\n\n" +
  "1) Link your wallet: /start, then tap the wallet button (testnet wallet via TON Connect).\n" +
  "2) Send a tip: /tip @username 1, or by voice from your G2 glasses.\n" +
  "3) Tap “Review & sign” and approve in your wallet.\n\n" +
  "Commands:\n" +
  "/start - link or change your wallet\n" +
  "/tip @user amount - send a tip (max 10 GRAM)\n" +
  "/wallet - show your linked wallet\n" +
  "/voicename Name - set the name friends say to the glasses\n" +
  "/unlink - remove your wallet from Jiko\n" +
  "/help - this message\n\n" +
  "The person you tip must have linked a wallet first. Testnet only: no real money. " +
  "Each tip request is valid for 5 minutes.";

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
        "\nSend a tip with /tip @username 1, or see /help.",
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

bot.command("unlink", async (ctx) => {
  const db = load();
  if (!db[ctx.from.id]) return ctx.reply("No wallet linked.");
  delete db[ctx.from.id];
  save(db);
  return ctx.reply("Wallet removed from Jiko ✅", { reply_markup: walletKeyboard(false) });
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
    return ctx.reply("@" + username + " hasn't linked a wallet yet. Ask them to open @jikppay_bot and press /start.");
  }
  const target = { ...entry[1], id: entry[0] };
  const msg = await ctx.reply(
    "Tip " + amount + " GRAM to @" + username + "?\nValid for 5 minutes.",
    { reply_markup: new InlineKeyboard().webApp("Review & sign", payLink(target, amount)) }
  );
  const me = db[ctx.from.id];
  if (me?.address) {
    watchPayment({
      senderAddr: me.address,
      senderId: ctx.from.id,
      senderLabel: me.username ? "@" + me.username : me.first_name || "someone",
      recipientId: target.id,
      nano: String(Math.round(amount * 1e9)),
      amount,
      label: "@" + username,
      messageId: msg.message_id,
    });
  } else {
    // without a linked sender wallet we can't watch the chain, so just expire the button
    setTimeout(() => {
      bot.api
        .editMessageText(msg.chat.id, msg.message_id, "⌛ Tip request expired. Send /tip again.")
        .catch(() => {});
    }, 300_000);
  }
});

bot.on("message:web_app_data", async (ctx) => {
  try {
    const data = JSON.parse(ctx.message.web_app_data.data);
    const db = load();
    const existed = Boolean(db[ctx.from.id]);
    const alias = db[ctx.from.id]?.alias;
    db[ctx.from.id] = {
      username: ctx.from.username ?? null,
      first_name: ctx.from.first_name ?? null,
      alias,
      address: data.address,
      chain: data.chain,
    };
    save(db);
    await ctx.reply(
      (existed ? "Wallet updated ✅\n" : "Wallet linked ✅\n") + data.address,
      { reply_markup: walletKeyboard(true) }
    );
  } catch (e) {
    console.error(e);
    await ctx.reply("Could not save the wallet.");
  }
});

startApi(bot);

bot.start({
  onStart: async (info) => {
    console.log("started as @" + info.username);
    await bot.api.setMyCommands([
      { command: "start", description: "Link or change your wallet" },
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