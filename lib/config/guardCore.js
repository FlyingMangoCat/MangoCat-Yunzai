/**
 * 防护通用工具 - 插件危险行为的通知与点名
 * 供 fsGuard（文件删除保护）与 cmdGuard（命令执行保护）共用
 */

import cfg from "./config.js";

/** 待补发通报队列：Bot 未连接（如插件加载阶段）时的通报先入队，连接就绪后自动补发，避免通报静默丢失 */
let pendingBroadcasts = [];
let pendingMasters = [];
let flushTimer = null;

/** Bot 是否已连接就绪（有登录的 Bot 且有群列表） */
function botReady() {
  try {
    const groups = global.Bot?.getGroupList?.() || [];
    const uins = global.Bot?.uin || [];
    return groups.length > 0 && uins.length > 0;
  } catch (err) {
    return false;
  }
}

/** 补发队列中的通报（群广播 + 私信主人），返回是否已清空 */
function flushPending() {
  try {
    if (!botReady()) return false;
    if (pendingBroadcasts.length) {
      const msgs = pendingBroadcasts.splice(0);
      const groups = global.Bot?.getGroupList?.() || [];
      msgs.forEach((msg, mi) =>
        groups.forEach((gid, i) =>
          setTimeout(() => {
            try {
              if (!cfg.checkGroup(gid)) return;
              global.Bot?.sendGroupMsg(gid, msg);
            } catch (err) {}
          }, (mi * groups.length + i) * 800),
        ),
      );
    }
    if (pendingMasters.length) {
      const msgs = pendingMasters.splice(0);
      for (const msg of msgs) global.Bot?.sendMasterMsg?.(msg);
    }
    if (!pendingBroadcasts.length && !pendingMasters.length) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    return true;
  } catch (err) {
    return false;
  }
}

/** 启动补发定时器（每 3 秒检查一次，最多 2 分钟，避免永久占用） */
function ensureFlushTimer() {
  if (flushTimer) return;
  let tries = 0;
  flushTimer = setInterval(() => {
    tries++;
    if (flushPending() || tries > 40) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }, 3000);
}

/** 从调用栈解析发起危险操作的插件文件（点名曝光用），非插件调用返回"未知来源" */
export function getCaller() {
  try {
    const stack = new Error().stack.split("\n");
    for (const line of stack) {
      // 匹配 plugins/xxx/apps/yyy.js 形式的调用者（兼容 file:// 前缀与 Windows 反斜杠）
      const m = line.match(/plugins[\\/][^:)]+?\.js/i);
      if (m) return m[0].replace(/\\/g, "/");
    }
  } catch (err) {}
  return "未知来源";
}

/**
 * 全群广播告警（极度危险时）
 * 按黑白名单过滤通知群，尊重用户配置：
 *  - 配置了白名单：只通知白名单内的群
 *  - 配置了黑名单：跳过黑名单群
 *  - 两者都未配置：通知全部群
 * Bot 未连接就绪时先入队，连接后自动补发，不丢通报
 */
export function broadcast(msg) {
  try {
    const groups = global.Bot?.getGroupList?.() || [];
    // Bot 未就绪（如插件加载阶段）：入队等待连接后补发
    if (!groups.length) {
      pendingBroadcasts.push(msg);
      ensureFlushTimer();
      return;
    }
    groups.forEach((gid, i) =>
      setTimeout(() => {
        try {
          // 黑白名单过滤：白名单优先，其次黑名单跳过（cfg.checkGroup 与消息入口判定一致）
          if (!cfg.checkGroup(gid)) return;
          global.Bot?.sendGroupMsg(gid, msg);
        } catch (err) {}
      }, i * 800),
    );
  } catch (err) {}
}

/** 私信主人（主人未配置时不提示、不崩溃；Bot 未连接就绪时先入队，连接后自动补发） */
export function notifyMaster(msg) {
  try {
    // 未配置任何主人时直接返回，避免无谓调用与报错
    if (!cfg.masterQQ?.length) return;
    const uins = global.Bot?.uin || [];
    // Bot 未就绪（如插件加载阶段）：入队等待连接后补发
    if (!uins.length) {
      pendingMasters.push(msg);
      ensureFlushTimer();
      return;
    }
    global.Bot?.sendMasterMsg?.(msg);
  } catch (err) {}
}
