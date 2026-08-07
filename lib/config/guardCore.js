/**
 * 防护通用工具 - 插件危险行为的通知与点名
 * 供 fsGuard（文件删除保护）与 cmdGuard（命令执行保护）共用
 */

import cfg from "./config.js";

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
 */
export function broadcast(msg) {
  try {
    const groups = global.Bot?.getGroupList?.() || [];
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

/** 私信主人 */
export function notifyMaster(msg) {
  try {
    global.Bot?.sendMasterMsg?.(msg);
  } catch (err) {}
}
