import child_process from "node:child_process";
import path from "node:path";
import fs from "node:fs";
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

/**
 * 从命令串解析本地资源脚本路径（bash/sh <plugins 下脚本> 形式）
 * @returns {string|null} 相对项目根、plugins/ 下的脚本路径；非本地资源脚本返回 null
 */
function parseLocalScript(cmd) {
  const m = String(cmd || "").trim().match(/^(?:bash|sh)\s+["']?([^\s"';&|<>]+)["']?/i);
  if (!m) return null;
  const scriptPath = m[1].replace(/^\.\//, "").split("?")[0];
  // 仅识别项目内 plugins/ 下的脚本；外部/绝对路径脚本不在静默范围（仍提示）
  if (!scriptPath.startsWith("plugins/")) return null;
  return scriptPath;
}

/**
 * 检测本地资源脚本的"实际内容"是否有危害动作（防脚本被篡改）
 * 静默放行脚本执行前，读取脚本文件内容并复用 checkCmdString 检测，
 * 脚本内若有 rm 删核心路径、curl|bash 远程执行等，同样按危险命令阻止。
 * 同时检测伪装/混淆绕过变体（引号拆分、命令替换、eval、base64 解码、
 * 下载再执行、python 远程执行等），命中即阻止，不静默。
 * @returns {string|null} 脚本内容中的危险原因，或 null（内容无害/读取失败）
 */
function checkScriptContent(cmd) {
  const scriptPath = parseLocalScript(cmd);
  if (!scriptPath) return null;
  try {
    const content = fs.readFileSync(scriptPath, "utf8");
    return checkCmdString(content) || checkObfuscatedCmd(content);
  } catch (err) {
    return null;
  }
}

/**
 * 检测脚本内容中的伪装/混淆绕过与远程执行变体
 * 覆盖：引号/空白拆分命令词、命令替换/进程替换、eval 远程执行、
 * 下载工具管道执行、下载后执行、base64 解码执行、python/perl 远程执行、
 * 混淆删除核心路径、绝对路径删除（根/盘符）
 * @returns {string|null} 危险原因或 null
 */
function checkObfuscatedCmd(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  // 命令替换/进程替换：$(curl ...)、`wget ...`、<(curl ...)
  if (/(?:<\(\s*|\$\s*\(\s*|\`\s*)(?:curl|wget|aria2c|axel|fetch|python3?|perl)\b/i.test(s)) return "命令替换/进程替换执行远程内容";
  // eval 执行远程/下载内容
  if (/\beval\b[^;]{0,200}(?:curl|wget|base64|python|perl|\$\(|\`|<\(|http)/i.test(s)) return "eval 执行远程内容";
  // 下载工具管道到 shell（容忍引号/空白拆分，如 cu"rl" / c'u'rl）
  if (/(?:c['\u0022\u0027 ]*u['\u0022\u0027 ]*r['\u0022\u0027 ]*l|w['\u0022\u0027 ]*g['\u0022\u0027 ]*e['\u0022\u0027 ]*t|aria2c|axel|fetch|python3?|perl)\b[^|;<>]{0,200}\|\s*(?:ba['\u0022\u0027 ]*sh|s['\u0022\u0027 ]*h|zsh|ksh|bash|sh)/i.test(s)) return "远程脚本管道执行";
  // 下载再执行：curl -o X && bash X / wget -O X; sh X
  if (/(?:curl|wget|aria2c|axel|fetch)\b[^;]{0,200}(?:-o|-O)\s+\S+.{0,80}(?:&&|;|\|)\s*(?:ba?sh|sh|zsh|ksh)\b\s+(?:\S+\/)?[a-z0-9_.-]+\.sh/i.test(s)) return "下载脚本后执行";
  // base64/hex 解码执行
  if (/(?:base64|xxd|openssl\s+base64|b64decode)[^|;<>]{0,60}\|.{0,60}\b(?:ba)?sh\b|(?:echo|cat|printf)[^|]{0,80}\|\s*base64\s+-d/i.test(s)) return "base64 解码后执行";
  // python/perl 远程执行
  if (/(?:python3?|perl)\s+-c\s+["'].{0,300}?(?:urllib|requests|urllib2|http\.client|LWP|IO::Socket)/i.test(s)) return "python/perl 远程执行";
  // 混淆删除核心路径（容忍引号/空白/选项拆分，与核心保护路径一致）
  const CORE_KEYWORDS = ["config","data","lib","renderers","docker","resources","plugins/adapter","app.js","fmc.js","package.json","package-lock.json","pnpm-lock.yaml","pnpm-workspace.yaml",".eslintrc.cjs",".npmrc",".puppeteerrc.cjs","Dockerfile","docker-compose.yaml","docker-entrypoint.sh"];
  const obfRm = new RegExp("\\brm\\b[\\s\"'\\-a-zA-Z]{0,40}?(" + CORE_KEYWORDS.map(k => k.replace(/\./g, "\\.")).join("|") + ")", "i");
  if (obfRm.test(s)) return "删除核心路径";
  // 绝对路径删除（根目录/根下全部/盘符根）
  if (/\brm\b[\s"\u0027\-a-zA-Z]{0,30}\s+["']?(?:\/[\s;|&]|\/\*\s|[\s"']?\/$|[a-zA-Z]:[\\\/])/i.test(s)) return "删除绝对路径";
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
 * 判断是否为纯版本/环境检查命令（pnpm -v、git --version 等，无副作用）
 * 严格匹配：整条命令仅含命令名+版本/帮助参数，不含管道/分号/重定向等组合，
 * 避免把 curl -v ... | bash 这类组合误判为版本检查
 */
function isVersionCheckCmd(cmd) {
  const text = String(cmd || "").trim();
  if (!text) return false;
  // 仅命令名 + 选项 + 版本/帮助参数结尾，且全串无管道/分号/重定向
  if (/[|;&<>]/.test(text)) return false;
  return /^[a-zA-Z0-9_.-]+(?:\s+-{1,2}[a-zA-Z]+\s*)*\s+-{1,2}(?:v|version|help)\s*$/i.test(text);
}

/**
 * 判断是否为纯只读命令（无副作用，静默放行不打扰）
 * 覆盖：git 只读查询（status/diff/log/rev-parse 等）、fastfetch/neofetch 系统信息采集
 * 严格匹配：整条命令仅含命令名+参数，不含管道/分号/重定向/命令替换等组合，
 * 防止 `git status && curl|bash` 这类组合被误判为只读
 */
function isSilentReadCmd(cmd) {
  const text = String(cmd || "").trim();
  if (!text) return false;
  // 含组合符号（管道/分号/重定向/&&/命令替换/进程替换）一律不静默
  if (/[|;&<>\$\(`]/.test(text)) return false;
  // git 只读查询命令（status/diff/log/rev-parse/show/branch/remote/ls-* 等）
  // 注意排除 reset/checkout/clean/rm 等有副作用的子命令
  if (/^(?:git|GIT)\s+(?:-C\s+["']?[^\s"']+["']?\s+)?(?:status|diff|log|rev-parse|show|branch|remote|tag|describe|ls-files|ls-tree|name-rev|rev-list|config|symbolic-ref|shortlog)\b/i.test(text)) return true;
  // fastfetch/neofetch 系统信息采集
  if (/^(?:fastfetch|neofetch)\b/i.test(text)) return true;
  return false;
}

/**
 * 校验静默命令的可执行文件是否可信（防伪装攻击）
 * 攻击者可能在项目内（plugins/ 等）放置与 git/fastfetch 同名的恶意脚本，
 * 或让插件用相对路径/项目内路径执行。静默前定位真实二进制路径：
 * - 命令 token 含路径（./x、plugins/x、绝对路径）→ 不静默（脚本分支由内容检测覆盖）
 * - 真实二进制位于项目目录内（cwd 下，含 plugins/）→ 判定为伪装，不静默
 * - 定位失败（command -v 查不到）→ 保守不静默
 * 仅系统路径（项目外）的真实二进制才可静默
 */
function isTrustedBinary(cmd) {
  const m = String(cmd || "").trim().match(/^"?([^\s"'|;&<>]+)"?/);
  if (!m) return false;
  const bin = m[1];
  // 带路径/相对路径的命令 token 不静默（脚本执行由 parseLocalScript 内容检测覆盖）
  if (bin.includes("/") || bin.includes("\\") || bin.startsWith(".")) return false;
  try {
    const out = child_process.execSync(`command -v ${bin}`, { encoding: "utf8" });
    const real = String(out || "").trim().split("\n")[0];
    if (!real) return false;
    const abs = path.resolve(real);
    const cwd = path.resolve(".");
    // 位于项目目录内（cwd 本身或 plugins/ 等子目录）→ 伪装同名命令，不可信
    if (abs === cwd || abs.startsWith(cwd + path.sep)) return false;
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * 非高危命令风险提示：插件执行命令时放行，但私信主人提示该插件具备命令执行能力
 * 仅针对 plugins/ 目录下的插件调用，本体（lib/、bot.js）执行命令不打扰
 * 静默条件只依赖命令本身无害（更新/版本检查），不依赖调用者——
 * 攻击者可能篡改自带插件文件，因此不能基于"调用者是否本体插件"信任
 */
function notifyPluginCmd(cmd, method) {
  const caller = getCaller();
  // 非插件调用（本体内部命令、未知来源）不提示
  if (!caller || caller === "未知来源" || !caller.startsWith("plugins/")) return;
  // 更新类命令静默放行：命令本身无危害（git pull / pnpm install），且可执行文件可信（防伪装）
  if (isSilentUpdateCmd(cmd) && isTrustedBinary(cmd)) return;
  // 纯版本/环境检查命令（pnpm -v、git --version 等）静默放行，且可执行文件可信
  if (isVersionCheckCmd(cmd) && isTrustedBinary(cmd)) return;
  // 纯只读命令（git status/diff/log 查询、fastfetch 系统信息采集）静默放行，且可执行文件可信
  if (isSilentReadCmd(cmd) && isTrustedBinary(cmd)) return;
  // 本地资源脚本（bash plugins/*/resources/*.sh 等）静默放行：
  // 能走到这里说明 wrap 层已检测过脚本实际内容无害（有害已在 wrap 层 block），
  // 脚本被篡改时内容检测会拦截，不会静默
  if (parseLocalScript(cmd)) return;
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
    // 双重检测：命令串本身 + 本地资源脚本的实际内容（防脚本被篡改）
    const hit = checkCmdString(cmd) || checkScriptContent(cmd);
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
    const cmdStr = `${file} ${Array.isArray(args) ? args.join(" ") : ""}`;
    // 双重检测：file/args 危险 + 命令串 + 本地资源脚本内容（防脚本被篡改）
    const hit = checkExecArgs(file, args) || checkCmdString(cmdStr) || checkScriptContent(cmdStr);
    if (hit) {
      blockCmd(cmdStr, hit, name);
      if (name.endsWith("Sync")) throw new Error(`[命令保护]已阻止危险命令：${hit}`);
      const callback = typeof cb === "function" ? cb : null;
      if (callback) callback(new Error(`[命令保护]已阻止危险命令：${hit}`));
      return;
    }
    notifyPluginCmd(cmdStr, name);
    return orig.apply(this, arguments);
  };
}

/** 包装 spawnSync */
function wrapSpawnSync() {
  const orig = child_process.spawnSync;
  if (typeof orig !== "function") return;
  child_process.spawnSync = function (file, args, opts) {
    const cmdStr = `${file} ${Array.isArray(args) ? args.join(" ") : ""}`;
    // 双重检测：file/args 危险 + 命令串 + 本地资源脚本内容（防脚本被篡改）
    const hit = checkExecArgs(file, args) || checkCmdString(cmdStr) || checkScriptContent(cmdStr);
    if (hit) {
      blockCmd(cmdStr, hit, "spawnSync");
      return { error: new Error(`[命令保护]已阻止危险命令：${hit}`), stdout: null, stderr: null, status: null, signal: null };
    }
    notifyPluginCmd(cmdStr, "spawnSync");
    return orig.apply(this, arguments);
  };
}

/** 包装 spawn（返回 ChildProcess，危险时同步抛错） */
function wrapSpawn() {
  const orig = child_process.spawn;
  if (typeof orig !== "function") return;
  child_process.spawn = function (file, args, opts) {
    const cmdStr = `${file} ${Array.isArray(args) ? args.join(" ") : ""}`;
    // 双重检测：file/args 危险 + 命令串 + 本地资源脚本内容（防脚本被篡改）
    const hit = checkExecArgs(file, args) || checkCmdString(cmdStr) || checkScriptContent(cmdStr);
    if (hit) {
      blockCmd(cmdStr, hit, "spawn");
      throw new Error(`[命令保护]已阻止危险命令：${hit}`);
    }
    notifyPluginCmd(cmdStr, "spawn");
    return orig.apply(this, arguments);
  };
}

/** 包装 util.exec（Bot.exec 的实现，TRSS 等插件均走此入口执行命令） */
function wrapUtilExec() {
  const orig = util.exec;
  if (typeof orig !== "function") return;
  util.exec = function (cmd, opts = {}) {
    // 双重检测：命令串本身 + 本地资源脚本的实际内容（防脚本被篡改）
    const hit = checkCmdString(cmd) || checkScriptContent(cmd);
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
