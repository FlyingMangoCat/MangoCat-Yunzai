import path from "node:path"

/**
 * 命令文本危险特征检测（无副作用）
 *
 * 运行时由 cmdGuard 用于拦截插件执行的危险命令，静态审计由 pluginAudit
 * 用于检查插件自带脚本；两处共用同一套规则，避免规则漂移。
 */

/** 核心保护路径（与 fsGuard 保持一致）：rm 删除这些 = 极度危险 */
const CORE_PATHS = [
  ".git",
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
export function checkPath(p) {
  p = String(p || "").replace(/^["']|["']$/g, "");
  if (!p) return false;
  // Windows 盘符、绝对路径、逃逸、项目根
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p === ".." || p.startsWith("../")) return true;
  // glob 通配符目标（dat* / ./* / con?fig / confi[g]）：精确匹配不到核心路径，
  // 但 shell 展开后可能命中。改查基础目录（通配符前的目录部分）：
  //  - 基础目录为空或 "."（dat*、./*，展开范围为 cwd）→ 拦截
  //  - 基础目录为核心路径（config/*）→ 拦截
  //  - 基础目录无害（temp/*.log 合法清理）→ 放行，不误伤
  if (/[*?[]/.test(p)) {
    const meta = p.search(/[*?[]/);
    const base = p.slice(0, meta);
    const slash = base.lastIndexOf("/");
    const dir = slash === -1 ? "." : base.slice(0, slash);
    return checkPath(dir);
  }
  const rel = toRel(p);
  return isCoreRel(rel);
}

/**
 * 检测命令字符串是否危险
 * @returns {string|null} 危险原因或 null
 */
export function checkCmdString(cmd) {
  const text = String(cmd || "");
  // 远程脚本管道执行：curl/wget 管道给任意代码解释器（sh/bash/zsh/ksh/dash、python、perl、node、ruby、php、lua）
  // 不能只认 sh——curl|python3、curl|node 等换解释器形态同样远程代码执行
  if (/\b(?:curl|wget)\b[^|;<>]*\|[^;]*\b(?:(?:ba|z|k)?sh|dash|python3?|perl|node|ruby|php|lua)\b/i.test(text)) return "远程脚本管道执行(curl|解释器)";
  // 远程脚本进程替换：bash <(curl ...)
  if (/\b(?:ba)?sh\b[^<]*<\s*\(\s*(?:curl|wget)\b/i.test(text)) return "远程脚本管道执行(sh <(curl))";
  // node -e/--eval/-p 内联脚本：子进程 fs 不受 fsGuard 约束，脚本内删核心路径等同 rm。
  // 直接扫脚本里的 fs 删除调用及其字符串参数，用 checkPath 与 rm 命令同一口径判定核心路径
  if (/\bnode\b[^\n|;&]*\s(?:-[ep]\b|--(?:eval|print)[\s=])/.test(text)) {
    const callRe = /(?:rmSync|rmdirSync|unlinkSync|\.\s*(?:rm|rmdir|unlink))\s*\(([^)]*)/gi;
    let cm;
    while ((cm = callRe.exec(text)) !== null) {
      const argRe = /["'`]([^"'`]+)["'`]/g;
      let am;
      while ((am = argRe.exec(cm[1])) !== null) {
        if (checkPath(am[1])) return `node -e 内联脚本删除核心路径【${am[1]}】`;
      }
    }
  }
  // 删除命令：rm/rmdir/del/rd 后跟危险路径
  // 全参数扫描：只查第一个目标会漏检 rm backup config（先无害后核心）与引号含空格路径 "config dir"
  const rmRe = /\b(?:rm|rmdir|del|rd)\b([^\n;|&]*)/gi;
  let rmM;
  while ((rmM = rmRe.exec(text)) !== null) {
    // 提取该段内全部目标 token（引号内路径取整体），跳过 -r/-f 选项与 Windows del 的 /q /s 类开关
    // 开关仅认单字母（/q、/s），防误跳 /root 等 Unix 单段绝对路径
    const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let tk;
    while ((tk = tokenRe.exec(rmM[1])) !== null) {
      const tok = tk[1] !== undefined ? tk[1] : tk[2] !== undefined ? tk[2] : tk[3];
      if (/^-[a-zA-Z]+$/.test(tok) || /^\/[a-zA-Z]$/.test(tok)) continue;
      if (checkPath(tok)) return `删除命令目标【${tok}】`;
    }
  }
  return null;
}

/**
 * 检测脚本内容中的伪装/混淆绕过与远程执行变体
 * 覆盖：引号/空白拆分命令词、命令替换/进程替换、eval 远程执行、
 * 下载工具管道执行、下载后执行、base64 解码执行、python/perl 远程执行、
 * 混淆删除核心路径、绝对路径删除（根/盘符）
 * @returns {string|null} 危险原因或 null
 */
export function checkObfuscatedCmd(text) {
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

/** 检查一段脚本文本是否包含危险命令（静态审计复用） */
export function inspectScriptText(text) {
  return checkCmdString(text) || checkObfuscatedCmd(text);
}

/** 去掉整行/块注释，避免注释里的示例命令被当成真实执行 */
export function stripScriptComments(text, ext = "") {
  const type = String(ext || "").toLowerCase();
  let s = String(text || "");
  if (type === ".ps1") {
    s = s.replace(/<#[\s\S]*?#>/g, "");
    s = s.replace(/^\s*#.*$/gm, "");
  } else if (type === ".bat" || type === ".cmd") {
    s = s.replace(/^\s*@?(?:rem\b|::).*$/gim, "");
  } else {
    s = s.replace(/^\s*#.*$/gm, "");
  }
  return s;
}
