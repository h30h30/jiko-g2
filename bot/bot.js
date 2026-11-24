import { Bot, Keyboard, InlineKeyboard } from "grammy";
import fs from "node:fs";
import crypto from "node:crypto";

const bot = new Bot(process.env.BOT_TOKEN);
const FILE = "registry.json";
const PAGE = "https://h30h30.github.io/jiko-g2";
const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {});
const save = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

const walletKeyboard = (linked) =>
  new Keyboard().webApp(linked ? "Change wallet" : "Link wallet", PAGE + "/").resized();

const HELP =
  "How Jiko works 🐦\n\n" +
  "1) Link your wallet: /start, then tap the wallet button (testnet wallet via TON Connect).\n" +
  "2) Send a tip: /tip @username 1\n" +
  "3) Tap “Review & sign” and approve in your wallet.\n\n" +
  "Commands:\n" +
  "/start - link or change your wallet\n" +
  "/tip @user amount - send a tip (max 10 GRAM)\n" +
  "/wallet - show your linked wallet\n" +
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
      "and soon by voice from your Even G2 glasses.\n\n" +
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

bot.command("tip", async (ctx) => {
  const [, rawUser, rawAmount] = ctx.message.text.trim().split(/\s+/);
  const username = (rawUser ?? "").replace(/^@/, "").toLowerCase();
  const amount = Number(rawAmount);
  if (!username || !(amount > 0) || amount > 10) {
    return ctx.reply("Usage: /tip @username 1  (max 10 GRAM, testnet)");
  }
  const db = load();
  const target = Object.values(db).find(
    (u) => (u.username ?? "").toLowerCase() === username
  );
  if (!target) {
    return ctx.reply("@" + username + " hasn't linked a wallet yet. Ask them to open @jikppay_bot and press /start.");
  }
  const rid = crypto.randomBytes(4).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + 300;
  const url =
    PAGE + "/pay.html?to=" + encodeURIComponent(target.address) +
    "&amount=" + amount + "&name=" + encodeURIComponent(username) +
    "&r=" + rid + "&exp=" + exp;
  const msg = await ctx.reply(
    "Tip " + amount + " GRAM to @" + username + "?\nValid for 5 minutes.",
    { reply_markup: new InlineKeyboard().webApp("Review & sign", url) }
  );
  setTimeout(() => {
    bot.api
      .editMessageText(msg.chat.id, msg.message_id, "⌛ Tip request expired. Send /tip again.")
      .catch(() => {});
  }, 300_000);
});

bot.on("message:web_app_data", async (ctx) => {
  try {
    const data = JSON.parse(ctx.message.web_app_data.data);
    const db = load();
    const existed = Boolean(db[ctx.from.id]);
    db[ctx.from.id] = {
      username: ctx.from.username ?? null,
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

bot.start({
  onStart: async (info) => {
    console.log("started as @" + info.username);
    await bot.api.setMyCommands([
      { command: "start", description: "Link or change your wallet" },
      { command: "tip", description: "Send a tip: /tip @username 1" },
      { command: "help", description: "Instructions" },
      { command: "wallet", description: "Show your linked wallet" },
      { command: "unlink", description: "Remove your wallet" },
    ]);
    await bot.api.setMyShortDescription("Send crypto tips on TON with one short command, soon by voice from G2 glasses.");
    await bot.api.setMyDescription(
      "Jiko helps you send crypto tips on TON (testnet demo) with one short command, and soon by voice from your Even G2 glasses. Tap Start to link your wallet."
    );
  },
});