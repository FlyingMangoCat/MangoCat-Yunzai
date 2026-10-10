/**
 * 防护通用工具 - 插件危险行为的通知与点名
 * 供 fsGuard（文件删除保护）与 cmdGuard（命令执行保护）共用
 */

import cfg from "./config.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** 待补发通报队列：Bot 未连接（如插件加载阶段）时的通报先入队，连接就绪后自动补发，避免通报静默丢失 */
let pendingBroadcasts = [];

// 干净引用：本体加载（早于任何插件代码）时快照 Error 构造器与栈格式化钩子。
// 插件若 monkey-patch Error/prepareStackTrace 伪造或过滤栈帧，可冒充"本体"骗取误报豁免——
// getCaller 一律用快照的干净 Error 并强制 V8 默认栈格式，使捕获到的栈不可伪造
const CleanError = Error;
const savedPrepareStackTrace = Error.prepareStackTrace;
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
    // 强制 V8 默认栈格式 + 干净 Error：防插件 patch prepareStackTrace / global.Error
    // 伪造 renderers|lib|config 栈帧冒充本体骗豁免，或过滤自身 plugins/ 帧逃过点名
    Error.prepareStackTrace = undefined;
    const stack = new CleanError().stack.split("\n");
    Error.prepareStackTrace = savedPrepareStackTrace;
    for (const line of stack) {
      // 匹配 plugins/xxx/apps/yyy.js 形式的调用者（兼容 file:// 前缀与 Windows 反斜杠）
      const m = line.match(/plugins[\\/][^:)]+?\.js/i);
      if (m) return m[0].replace(/\\/g, "/");
    }
    // 本体自身代码（renderers/lib/config 等）发起的操作：明确标注本体，避免误报为可疑插件
    for (const line of stack) {
      const m = line.match(/(?:renderers|lib|config)[\\/][^:)]+?\.js/i);
      if (m) return `本体(${m[0].replace(/\\/g, "/")})`;
    }
  } catch (err) {
    // 无论成败都恢复插件可能设置的栈钩子，不影响业务自身的 source-map 等用途
    try { Error.prepareStackTrace = savedPrepareStackTrace; } catch (e) {}
  }
  return "未知来源";
}

/** 本体文件哈希校验结果缓存（key: 相对路径），避免同一文件反复执行 git */
const selfHashCache = new Map();

/**
 * 校验"本体(xxx)"调用是否可信：调用方文件在磁盘上的 git blob 哈希
 * 与仓库 HEAD 中记录一致，即内容未被篡改 → 其删除行为属本体自身逻辑，判定误报。
 * 哈希对不上（文件被改过/HEAD 里不存在）时不豁免，照常通报。
 */
export function isVerifiedSelf(caller) {
  try {
    const m = String(caller).match(/^本体\((.+)\)$/);
    if (!m) return false;
    const rel = m[1].replace(/\\/g, "/");
    if (selfHashCache.has(rel)) return selfHashCache.get(rel);
    let ok = false;
    const abs = path.resolve(rel);
    if (fs.existsSync(abs)) {
      // 纯 node 计算 git blob 哈希：sha1("blob <size>\0" + 内容)，等价 git hash-object
      const content = fs.readFileSync(abs);
      const hash = crypto.createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
      const head = execFileSync("git", ["rev-parse", `HEAD:${rel}`], {
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }).toString().trim();
      ok = hash === head;
    }
    selfHashCache.set(rel, ok);
    return ok;
  } catch (err) {
    return false;
  }
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
