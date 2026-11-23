import { Bot } from "grammy";

const bot = new Bot(process.env.BOT_TOKEN);

bot.catch((err) => console.error("BOT ERROR:", err));

bot.on("message", async (ctx, next) => {
  console.log("update:", ctx.message.text);
  await next();
});

bot.command("start", (ctx) => ctx.reply("Hi! I'm jiko 🐦"));

bot.start({
  onStart: (info) => console.log("started as @" + info.username),
});

console.log("Bot is running");
