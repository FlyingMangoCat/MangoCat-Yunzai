import child_process from "node:child_process";
import path from "node:path";
import cfg from "./config.js";
import util from "../util.js";
import { getCaller, broadcast, notifyMaster } from "./guardCore.js";

/**
 * 命令执行保护层 - 动态拦截插件执行的危险 shell 命令
 *
 * 背景：fsGuard 只拦截 fs 模块的删除方法，但 TRSS 类插件用
 * child_process 执行 `rm -rf data` / `curl | bash` 等系统命令，fs 层拦不到。
 * 本模块在插件加载前包装 child_process 与 util.exec（Bot.exec 的实现），
 * 检测危险命令并阻止 + 点名广播。
 *
 * 注意：Node ESM 对内置模块的命名导入（import { exec }）不是实时绑定，
 * 仅替换 child_process 属性拦不住命名导入；因此同时包装 util.exec，
 * 覆盖插件通过 Bot.exec 执行命令的路径（TRSS 等插件均走此入口）。
 *
 * 分级处理：
 *  - 极度危险（rm 删除核心路径/逃逸路径、curl|bash 远程脚本执行）：阻止执行，
 *    全群广播点名 + 私信主人
 *  - 正常命令（git pull、ffmpeg、node 脚本等）：放行
 *
 * 可通过 config/config/other.yaml 的 cmdGuard 开关关闭
 */

/** 核心保护路径（与 fsGuard 保持一致）：rm 删除这些 = 极度危险 */
const CORE_PATHS = [
  "config",
  "data",
  "lib",
  "renderers",
  "docker",
  "resources",
  "plugins/adapter",
  "app.js",
  "fmc.js",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".eslintrc.cjs",
  ".npmrc",
  ".puppeteerrc.cjs",
  "Dockerfile",
  "docker-compose.yaml",
  "docker-entrypoint.sh",
];

let installed = false;

/** 将目标路径转为相对项目根目录的路径 */
function toRel(target) {
  try {
    return path.relative(process.cwd(), path.resolve(target)).replace(/\\/g, "/");
  } catch (err) {
    return null;
  }
}

/** 判断相对路径是否核心保护路径 */
function isCoreRel(rel) {
  if (rel === "" || rel === ".") return true;
  if (!rel) return false;
  // 逃逸到项目外（../、跨盘符绝对路径）
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true;
  for (const f of CORE_PATHS) {
    if (rel === f || rel.startsWith(f + "/")) return true;
  }
  return false;
}

/** 判断 rm 目标路径是否危险（核心路径/逃逸/项目根） */
function checkPath(p) {
  p = String(p || "").replace(/^["']|["']$/g, "");
  if (!p) return false;
  // Windows 盘符、绝对路径、逃逸、项目根
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p === ".." || p.startsWith("../")) return true;
  const rel = toRel(p);
  return isCoreRel(rel);
}

/**
 * 检测命令字符串是否危险
 * @returns {string|null} 危险原因或 null
 */
function checkCmdString(cmd) {
  const text = String(cmd || "");
  // 远程脚本管道执行：curl|bash / wget|sh（管道不能拆段，否则检测失效）
  if (/\b(?:curl|wget)\b[^|;<>]*\|[^;]*\b(?:ba)?sh\b/i.test(text)) return "远程脚本管道执行(curl|bash)";
  // 远程脚本进程替换：bash <(curl ...)
  if (/\b(?:ba)?sh\b[^<]*<\s*\(\s*(?:curl|wget)\b/i.test(text)) return "远程脚本管道执行(sh <(curl))";
  // 删除命令：rm/rmdir/del/rd 后跟危险路径
  const m = text.match(/\b(?:rm|rmdir|del|rd)\b(?:\s+(?:-[a-zA-Z]+|\/[a-zA-Z]+))*\s+["']?([^\s"';&|]+)/i);
  if (m && checkPath(m[1])) return `删除命令目标【${m[1]}】`;
  return null;
}

/** 检测 execFile/spawn 参数数组是否危险（file 为 rm 类且参数含危险路径） */
function checkExecArgs(file, args) {
  const base = path.basename(String(file || "")).toLowerCase();
  if (!["rm", "rmdir", "del", "rd", "rm.exe", "rmdir.exe", "del.exe", "rd.exe"].includes(base)) return null;
  for (const a of args || []) {
    if (checkPath(a)) return `删除命令目标【${a}】`;
  }
  return null;
}

/** 极度危险：阻止 + 全群广播 + 私信主人（点名插件） */
function blockCmd(cmd, reason, method) {
  const caller = getCaller();
  const text = `🚨 安全警告：插件【${caller}】正在试图执行危险命令（${reason}），已阻止！\n该行为极度危险，疑似恶意插件，请立即检查并卸载。`;
  try {
    global.logger?.mark(`[命令保护]已阻止危险命令[${method}]：${String(cmd).slice(0, 200)}（${reason}，来源：${caller}）`);
  } catch (err) {}
  broadcast(text);
  notifyMaster(`🚨 检测到插件【${caller}】执行危险命令（${method}）：\n${String(cmd).slice(0, 200)}\n原因：${reason}\n已阻止该操作，未执行。\n如属插件更新行为请联系插件作者确认；请立即检查 plugins/ 目录。\n\n如确认是误报/插件正常更新行为，可临时关闭命令保护：将 config/config/other.yaml 中的 cmdGuard 改为 false 后重启。`);
}

/** 插件命令风险提示节流：caller -> 最后提示时间戳，防止刷屏 */
const pluginCmdNotified = new Map();
/** 同一插件命令风险提示最小间隔（毫秒），默认 10 分钟 */
const PLUGIN_CMD_NOTIFY_INTERVAL = 10 * 60 * 1000;

/**
 * 判断是否为静默放行的更新类命令（插件正常更新行为，不打扰主人）
 * 仅用于决定是否发风险提示；命令是否危险仍由 checkCmdString/checkExecArgs 拦截，
 * 因此这里只匹配纯更新动作，其余命令（含疑似危害）照常提示，不漏判也不误判
 */
function isSilentUpdateCmd(cmd) {
  const text = String(cmd || "").trim();
  if (!text) return false;
  // exec 字符串模式：git pull / git fetch / git merge / git submodule update / git reset --hard 更新场景
  if (/^(?:git|GIT)\s+(?:pull|fetch|merge|submodule\s+update|reset\s+--hard(?:\s+origin(?:\/\S+)?)?)/i.test(text)) return true;
  // 包管理安装/更新：pnpm install / npm install / yarn install / pnpm update 等
  if (/^(?:pnpm|npm|yarn)(?:\s+-[a-zA-Z]+\s*)*\s+(?:install|update|add)\b/i.test(text)) return true;
  // execFile/spawn 模式：组合串以 git <子命令> 开头（args 已拼入 cmd）
  if (/^(?:git|GIT)\s+(?:pull|fetch|merge|submodule\s+update|reset\s+--hard)\b/i.test(text)) return true;
  return false;
}

/**
 * 非高危命令风险提示：插件执行命令时放行，但私信主人提示该插件具备命令执行能力
 * 仅针对 plugins/ 目录下的插件调用，本体（lib/、bot.js）执行命令不打扰
 * 更新类命令（git pull 等）静默放行，不提示
 */
function notifyPluginCmd(cmd, method) {
  const caller = getCaller();
  // 非插件调用（本体内部命令、未知来源）不提示
  if (!caller || caller === "未知来源" || !caller.startsWith("plugins/")) return;
  // 更新类命令静默放行：插件正常更新行为，无需打扰主人
  if (isSilentUpdateCmd(cmd)) return;
  const now = Date.now();
  const last = pluginCmdNotified.get(caller) || 0;
  if (now - last < PLUGIN_CMD_NOTIFY_INTERVAL) return; // 节流防刷屏
  pluginCmdNotified.set(caller, now);
  try {
    global.logger?.mark(`[命令保护]插件执行命令[${method}]：${caller} -> ${String(cmd).slice(0, 200)}`);
  } catch (err) {}
  notifyMaster(`⚠️ 风险提示：插件【${caller}】正在执行系统命令（${method}）：\n${String(cmd).slice(0, 200)}\n已放行。该插件具备命令执行能力，如非必要请检查该插件是否可信。\n\n如确认是误报/该插件正常功能，可关闭本提示：将 config/config/other.yaml 中的 cmdGuard 改为 false 后重启。`);
}

/** 包装 exec / execSync */
function wrapExec(name) {
  const orig = child_process[name];
  if (typeof orig !== "function") return;
  child_process[name] = function (cmd, opts, cb) {
    const hit = checkCmdString(cmd);
    if (hit) {
      blockCmd(cmd, hit, name);
      if (name.endsWith("Sync")) throw new Error(`[命令保护]已阻止危险命令：${hit}`);
      const callback = typeof opts === "function" ? opts : cb;
      if (typeof callback === "function") callback(new Error(`[命令保护]已阻止危险命令：${hit}`));
      return;
    }
    notifyPluginCmd(cmd, name);
    return orig.apply(this, arguments);
  };
}

/** 包装 execFile / execFileSync */
function wrapExecFile(name) {
  const orig = child_process[name];
  if (typeof orig !== "function") return;
  child_process[name] = function (file, args, opts, cb) {
    // 参数归一化：execFile(file[, args][, options][, callback])
    if (args && typeof args === "object" && !Array.isArray(args)) {
      cb = opts;
      opts = args;
      args = undefined;
    } else if (typeof opts === "function") {
      cb = opts;
      opts = undefined;
    }
    const hit = checkExecArgs(file, args) || checkCmdString(file + " " + (Array.isArray(args) ? args.join(" ") : ""));
    if (hit) {
      blockCmd(`${file} ${Array.isArray(args) ? args.join(" ") : ""}`, hit, name);
      if (name.endsWith("Sync")) throw new Error(`[命令保护]已阻止危险命令：${hit}`);
      const callback = typeof cb === "function" ? cb : null;
      if (callback) callback(new Error(`[命令保护]已阻止危险命令：${hit}`));
      return;
    }
    notifyPluginCmd(`${file} ${Array.isArray(args) ? args.join(" ") : ""}`, name);
    return orig.apply(this, arguments);
  };
}

/** 包装 spawnSync */
function wrapSpawnSync() {
  const orig = child_process.spawnSync;
  if (typeof orig !== "function") return;
  child_process.spawnSync = function (file, args, opts) {
    const hit = checkExecArgs(file, args) || checkCmdString(file + " " + (Array.isArray(args) ? args.join(" ") : ""));
    if (hit) {
      blockCmd(`${file} ${Array.isArray(args) ? args.join(" ") : ""}`, hit, "spawnSync");
      return { error: new Error(`[命令保护]已阻止危险命令：${hit}`), stdout: null, stderr: null, status: null, signal: null };
    }
    notifyPluginCmd(`${file} ${Array.isArray(args) ? args.join(" ") : ""}`, "spawnSync");
    return orig.apply(this, arguments);
  };
}

/** 包装 spawn（返回 ChildProcess，危险时同步抛错） */
function wrapSpawn() {
  const orig = child_process.spawn;
  if (typeof orig !== "function") return;
  child_process.spawn = function (file, args, opts) {
    const hit = checkExecArgs(file, args) || checkCmdString(file + " " + (Array.isArray(args) ? args.join(" ") : ""));
    if (hit) {
      blockCmd(`${file} ${Array.isArray(args) ? args.join(" ") : ""}`, hit, "spawn");
      throw new Error(`[命令保护]已阻止危险命令：${hit}`);
    }
    notifyPluginCmd(`${file} ${Array.isArray(args) ? args.join(" ") : ""}`, "spawn");
    return orig.apply(this, arguments);
  };
}

/** 包装 util.exec（Bot.exec 的实现，TRSS 等插件均走此入口执行命令） */
function wrapUtilExec() {
  const orig = util.exec;
  if (typeof orig !== "function") return;
  util.exec = function (cmd, opts = {}) {
    const hit = checkCmdString(cmd);
    if (hit) {
      blockCmd(cmd, hit, "Bot.exec");
      return Promise.resolve({ error: new Error(`[命令保护]已阻止危险命令：${hit}`), stdout: "", stderr: "", raw: {} });
    }
    notifyPluginCmd(cmd, "Bot.exec");
    return orig.call(this, cmd, opts);
  };
}

/**
 * 安装命令执行保护层
 * 必须在插件加载前调用（本模块被 bot.js 顶部 import 时自动执行）
 */
export function install() {
  if (installed) return;
  installed = true;
  // 开关：other.yaml 的 cmdGuard，默认开启
  if (cfg.getOther().cmdGuard === false) return;
  try {
    wrapExec("exec");
    wrapExec("execSync");
    wrapExecFile("execFile");
    wrapExecFile("execFileSync");
    wrapSpawnSync();
    wrapSpawn();
    wrapUtilExec();
    global.logger?.info("命令执行保护层已启用：拦截 rm 删除核心目录与远程脚本执行");
  } catch (err) {
    try {
      global.logger?.error("[命令保护]安装失败", err);
    } catch (e) {}
  }
}

install();
