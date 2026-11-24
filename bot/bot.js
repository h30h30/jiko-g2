import { Bot, Keyboard } from "grammy";
import fs from "node:fs";

const bot = new Bot(process.env.BOT_TOKEN);
const FILE = "registry.json";
const load = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {});
const save = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));

bot.catch((err) => console.error("BOT ERROR:", err));

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