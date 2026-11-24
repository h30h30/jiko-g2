import { Bot, Keyboard, InlineKeyboard } from "grammy";
import fs from "node:fs";

const bot = new Bot(process.env.BOT_TOKEN);
const FILE = "registry.json";
const PAGE = "https://h30h30.github.io/jiko-g2";
const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {});
const save = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

const walletKeyboard = (linked) =>
  new Keyboard()
    .webApp(linked ? "Change wallet" : "Link wallet", PAGE + "/")
    .resized();

bot.catch((err) => console.error("BOT ERROR:", err));

bot.command("start", async (ctx) => {
  const db = load();
  const me = db[ctx.from.id];
  if (me) {
    me.username = ctx.from.username ?? null;
    save(db);
    return ctx.reply(
      "Hi! I'm jiko 🐦\nYour wallet: " + short(me.address) +
        "\nTip someone: /tip @username 1",
      { reply_markup: walletKeyboard(true) }
    );
  }
  return ctx.reply("Hi! I'm jiko 🐦 Tap the button to link your wallet.", {
    reply_markup: walletKeyboard(false),
  });
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
  const url =
    PAGE + "/pay.html?to=" + encodeURIComponent(target.address) +
    "&amount=" + amount + "&name=" + encodeURIComponent(username);
  await ctx.reply("Tip " + amount + " GRAM to @" + username + "?", {
    reply_markup: new InlineKeyboard().webApp("Review & sign", url),
  });
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
    ]);
  },
});