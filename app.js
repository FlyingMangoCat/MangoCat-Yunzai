import Yunzai from "./lib/bot.js";

// 设置启动类型，用于 Bot.restart()/Bot.exit() 中 pm2 分支的判断
if (process.argv[1]?.includes("pm2")) {
  global.start_type = "pm2";
} else {
  global.start_type = "internal";
}

global.Bot = new Yunzai()
Bot.run()
