/** Promise.withResolvers polyfill（兼容 Node < 22，使用 Object.defineProperty 确保严格模式下生效） */
if (!Promise.withResolvers) {
  Object.defineProperty(Promise, "withResolvers", {
    value: function () {
      let resolve, reject
      const promise = new Promise((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    },
    writable: true,
    configurable: true,
  })
}

import createQQ from "./qq.js";
import setLog from "./log.js";
import redisInit from "./redis.js";
import { checkRun } from "./check.js";
import cfg from "./config.js";
import fs from "fs";

/** 设置标题 */
process.title = `MangoCat-Yunzai v${cfg.package.version}`;
/** 设置时区 */
process.env.TZ = "Asia/Shanghai";

/** 捕获未处理的Promise错误 */
process.on("unhandledRejection", (error, promise) => {
  let err = error;
  if (logger) {
    logger.error(err);
  } else {
    console.log(err);
  }
});

/** 捕获未处理的异常，防止插件错误导致崩溃 */
process.on("uncaughtException", (error) => {
  if (logger) {
    logger.error(error);
  } else {
    console.log(error);
  }
});

/** 退出事件 */
process.on("exit", async (code) => {
  if (typeof redis != "undefined" && typeof test == "undefined") {
    await redis.save();
  }
});

await checkInit();

/** 初始化事件 */
async function checkInit() {
  /** 检查qq.yaml */
  await createQQ();

  /** 日志设置 */
  setLog();

  logger.mark("MangoCat-Yunzai 启动中...");

  await redisInit();

  checkRun();
}
