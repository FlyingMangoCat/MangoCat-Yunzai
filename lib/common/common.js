import { pipeline } from "stream";
import { promisify } from "util";
import fetch from "node-fetch";
import fs from "node:fs";
import path from "node:path";

/**
 * 发送私聊消息，仅给好友发送
 * @param user_id qq号
 * @param msg 消息
 * @param uin 指定 bot 发送，默认 Bot.uin（多 bot 场景可指定具体 bot）
 */
async function relpyPrivate(userId, msg, uin = Bot.uin) {
  userId = Number(userId);

  let friend = Bot.fl.get(userId);
  if (friend) {
    logger.mark(`发送好友消息[${friend.nickname}](${userId})`);
    // 指定具体 bot 且该 bot 已登录 → 用指定 bot 发送
    if (uin && !Array.isArray(uin) && Bot.bots?.[uin]) {
      return await Bot.bots[uin]
        .pickFriend(userId)
        .sendMsg(msg)
        .catch((err) => {
          logger.mark(err);
        });
    }
    // 默认走 Bot Proxy 自动路由
    return await Bot.pickUser(userId)
      .sendMsg(msg)
      .catch((err) => {
        logger.mark(err);
      });
  }
}

/**
 * 休眠函数
 * @param ms 毫秒
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 下载保存文件
 * @param fileUrl 下载地址
 * @param savePath 保存路径
 */
async function downFile(fileUrl, savePath, param = {}) {
  try {
    mkdirs(path.dirname(savePath));
    logger.debug(`[下载文件] ${fileUrl}`);
    const response = await fetch(fileUrl, param);
    const streamPipeline = promisify(pipeline);
    await streamPipeline(response.body, fs.createWriteStream(savePath));
    return true;
  } catch (err) {
    logger.error(`下载文件错误：${err}`);
    return false;
  }
}

function mkdirs(dirname) {
  if (fs.existsSync(dirname)) {
    return true;
  } else {
    if (mkdirs(path.dirname(dirname))) {
      fs.mkdirSync(dirname);
      return true;
    }
  }
}

/**
 * 制作转发消息
 * @param e oicq消息e
 * @param msg 消息数组
 * @param dec 转发描述
 */
async function makeForwardMsg(e, msg = [], dec = "", msgsscr = false) {
  if (!Array.isArray(msg)) {
    msg = [msg];
  }

  // msgsscr=true 时伪装为发送者署名，否则用 Bot 身份
  let nickname = msgsscr ? e.sender?.card || e.sender?.user_id || Bot.nickname : Bot.nickname;
  let user_id = msgsscr ? e.sender?.user_id || Bot.uin : Bot.uin;

  if (e.isGroup) {
    try {
      let info = await Bot.getGroupMemberInfo(e.group_id, user_id);
      nickname = info.card || info.nickname;
    } catch (err) {}
  }
  let userInfo = {
    user_id,
    nickname,
  };

  let forwardMsg = [];
  for (const message of msg) {
    if (!message) continue;
    forwardMsg.push({
      ...userInfo,
      message: message,
    });
  }

  /** 制作转发内容 */
  try {
    if (e?.group?.makeForwardMsg) {
      forwardMsg = await e.group.makeForwardMsg(forwardMsg);
    } else if (e?.friend?.makeForwardMsg) {
      forwardMsg = await e.friend.makeForwardMsg(forwardMsg);
    } else {
      return msg.join("\n");
    }

    if (dec) {
      /** 处理描述 */
      if (typeof forwardMsg.data === "object") {
        let detail = forwardMsg.data?.meta?.detail;
        if (detail) {
          detail.news = [{ text: dec }];
        }
      } else if (typeof forwardMsg.data === "string") {
        forwardMsg.data = forwardMsg.data
          .replace(/\n/g, "")
          .replace(/<title color="#777777" size="26">(.+?)<\/title>/g, "___")
          .replace(/___+/, `<title color="#777777" size="26">${dec}</title>`);
      }
    }
  } catch (err) {}

  return forwardMsg;
}

export default { sleep, relpyPrivate, downFile, makeForwardMsg };
