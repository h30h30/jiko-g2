import { Bot, Keyboard, InlineKeyboard } from "grammy";
import fs from "node:fs";

const bot = new Bot(process.env.BOT_TOKEN);
const FILE = "registry.json";
const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {});
const save = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));

bot.catch((err) => console.error("BOT ERROR:", err));

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
    "https://h30h30.github.io/jiko-g2/pay.html?to=" + encodeURIComponent(target.address) +
    "&amount=" + amount + "&name=" + encodeURIComponent(username);
  await ctx.reply("Tip " + amount + " GRAM to @" + username + "?", {
    reply_markup: new InlineKeyboard().webApp("Review & sign", url),
  });
});

bot.command("start", (ctx) =>
  ctx.reply("Hi! I'm jiko 🐦 Tap the button to link your wallet.", {
    reply_markup: new Keyboard()
      .webApp("Link wallet", "https://h30h30.github.io/jiko-g2/")
      .resized(),
  })
);

bot.on("message:web_app_data", async (ctx) => {
  try {
    const data = JSON.parse(ctx.message.web_app_data.data);
    const db = load();
    db[ctx.from.id] = {
      username: ctx.from.username ?? null,
      address: data.address,
      chain: data.chain,
    };
    save(db);
    await ctx.reply("Wallet linked ✅\n" + data.address);
  } catch (e) {
    console.error(e);
    await ctx.reply("Could not save the wallet.");
  }
});

bot.start({ onStart: (info) => console.log("started as @" + info.username) });