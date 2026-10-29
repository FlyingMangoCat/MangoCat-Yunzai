#!/usr/bin/env node
/**
 * plugin-audit.mjs — 云崽插件安全审计（纯本地静态，不联网）
 *
 * 用法：
 *   node tools/plugin-audit.mjs <插件目录> [更多目录...] [选项]
 *
 * 选项：
 *   --since <rev>       增量审计：只扫 git diff <rev> 之后新增/修改的行（新文件全扫）
 *   --ratchet [路径]    棘轮门禁：与基线比对，出现新增命中即判红；修复则自动下调基线
 *   --accept            配合 --ratchet：把当前结果接受为新基线（有风险，会打印提示）
 *   --fail-on <level>   不带基线也能拦 CI：critical|high|medium|low，命中即 exit 1
 *   --rules <json>      外部规则覆盖（缺省按 id 合并，disable 列表可关单条，replace:true 整份替换）
 *   --dump-rules <json> 导出当前内置规则为 JSON，改完可用 --rules 回灌
 *   --md <路径>         指定 Markdown 报告路径（多目标时当作前缀加插件名后缀）
 *   --no-md             只出终端结论，不写报告文件
 *   --json <路径>       额外输出 JSON
 *   --top <N>           终端最多显示 N 条（默认 15）
 *   --all-md            报告里列出全部命中，不按级别截断
 *
 * 分级：CRITICAL / HIGH / MEDIUM / LOW / PASS
 * 诚实边界：本工具做 S0 取证、S1 清点、S2 红线扫描、S3 可达性分诊（邻近 + 一跳变量，
 *          不是完整数据流）；S4「定性」仍需人读源码，报告末尾固定输出盲区声明。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/* ─────────────── 参数 ─────────────── */

const argv = process.argv.slice(2);
const opts = {
  md: null, noMd: false, json: null, top: 15, allMd: false,
  since: null, ratchet: null, accept: false, rules: null, dumpRules: null, failOn: null,
};
const targets = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[i + 1];
  if (a === "--md") opts.md = argv[++i];
  else if (a === "--no-md") opts.noMd = true;
  else if (a === "--json") opts.json = argv[++i];
  else if (a === "--top") opts.top = Number(argv[++i]);
  else if (a === "--all-md") opts.allMd = true;
  else if (a === "--since") opts.since = argv[++i];
  else if (a === "--accept") opts.accept = true;
  else if (a === "--rules") opts.rules = argv[++i];
  else if (a === "--dump-rules") opts.dumpRules = argv[++i];
  else if (a === "--fail-on") opts.failOn = argv[++i];
  else if (a === "--ratchet") {
    if (next() && !next().startsWith("-")) opts.ratchet = argv[++i];
    else opts.ratchet = "tools/plugin-audit-baseline.json";
  } else if (!a.startsWith("-")) targets.push(a);
}
if (!targets.length && !opts.dumpRules) {
  console.error("用法: node tools/plugin-audit.mjs <插件目录> [--since rev] [--ratchet] [--md out.md]");
  process.exit(1);
}

/* ─────────────── 常量 ─────────────── */

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "coverage",
  ".cache", "vendor", ".idea", ".vscode", "__pycache__",
]);
const SCAN_EXT = new Set([
  ".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".vue", ".json", ".yaml", ".yml",
  ".toml", ".ini", ".properties", ".md", ".markdown", ".txt", ".html", ".htm",
]);
const BINARY_EXT = new Set([".node", ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm"]);
const MAX_FILE_BYTES = 1_500_000;

const RE_INPUT = /\b(?:e\.msg|e\.raw_message|e\.message|e\.original_msg|msg\.replace|msg\.trim|msg\.split|e\.msg\.replace)\b/;
const RE_GATE = /\b(?:e\.isMaster|isMaster|permission\s*:\s*['"]master|auth\s*:\s*['"]master|checkAuth\s*\(\s*\{\s*auth\s*:\s*['"]master|\.checkAuth\s*\(|auth\s*===?\s*['"]master)/;
const RE_DATA_PATH = /data\//;

/**
 * 文件类型路由：有序表，先匹配先生效（specific 必须先于 generic）。
 * 每个 profile 决定该文件跑哪几类规则——避免 Markdown 也被拿去查 eval。
 */
const ROUTE = [
  { pat: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock", "go.sum", "*.lock"], profile: "skip" },
  { pat: ["package.json"], profile: "pkg" },
  { pat: ["*.md", "*.markdown", "*.txt", "*.rst"], profile: "doc" },
  { pat: ["*.json", "*.json5", "*.yaml", "*.yml", "*.toml", "*.ini", "*.properties"], profile: "config" },
  { pat: ["*.js", "*.cjs", "*.mjs", "*.jsx", "*.ts", "*.tsx", "*.vue", "*.html", "*.htm"], profile: "code" },
];
const PROFILES = {
  code: new Set(["RCE", "混淆", "凭据", "云崽特有", "外联", "其它", "防御"]),
  config: new Set(["凭据", "外联"]),
  doc: new Set(["凭据"]),
  pkg: new Set(["凭据"]),
  skip: new Set(),
};

/**
 * 红线规则表。
 * re 命中即记录；fp 是该规则的已知误报模式（命中则丢弃）。
 * 误报基线是本工具的核心资产——每条都来自实际审计中踩过的坑。
 */
const RULES = [
  /* —— RCE：代码/命令执行 —— */
  {
    id: "RCE-EVAL", family: "RCE", base: "HIGH", note: "eval 执行字符串",
    re: /(?<![.\w$])eval\s*\(/g,
    fp: [/\$eval\s*\(/, /\beval\s*\(\s*\)\s*(?:=>|\{)/, /\bfunction\s+eval\b/, /\beval\s*\(\s*\)\s*;?\s*$/],
    hint: "确认被 eval 的文本是配置/常量，还是 e.msg 等用户输入",
  },
  {
    id: "RCE-NEWFUNC", family: "RCE", base: "HIGH", note: "new Function 动态造函数",
    re: /(?<![.\w$])new\s+Function\s*\(/g,
    fp: [],
    hint: "确认函数体来源；常见良性：模板渲染、算术计算器（应带字符集白名单）",
  },
  {
    id: "RCE-VM", family: "RCE", base: "HIGH", note: "vm 沙箱执行",
    re: /runInThisContext|runInNewContext|runInContext|new\s+vm\.Script|vm\.compileFunction/g,
    fp: [],
    hint: "确认执行的是本地资源/模板，还是远端下发内容",
  },
  {
    id: "RCE-EXEC", family: "RCE", base: "HIGH", note: "同步/异步命令执行",
    re: /(?<![.\w$])(?:execSync|spawnSync|execFileSync|execFile)\s*\(/g,
    fp: [/\.exec\s*\(/],
    hint: "确认命令串是否拼接用户输入，以及是否在主人口令门禁之后",
  },
  {
    id: "RCE-EXEC-PLAIN", family: "RCE", base: "MEDIUM", note: "exec/spawn 调用",
    re: /(?<![.\w$])exec\s*\(|(?<![.\w$])spawn\s*\(/g,
    fp: [/\.exec\s*\(/, /\.spawn\s*\(/],
    hint: "注意：RegExp.exec() 是正则提取不是命令执行，已用负回顾排除 .exec(",
  },
  {
    id: "RCE-CHILDPROC", family: "RCE", base: "MEDIUM", note: "引入 child_process（仅能力，非调用）",
    re: /require\(\s*['"](?:node:)?child_process['"]\s*\)|from\s+['"](?:node:)?child_process['"]/g,
    fp: [],
    sink: false,
    hint: "只是具备执行能力，未见 sink 调用；不按 RCE 升级，需逐个调用点确认",
  },
  {
    id: "RCE-CHILDPROC-DOT", family: "RCE", base: "HIGH", note: "child_process 直调 exec/spawn",
    re: /(?:child_?[pP]rocess|childProcess|\bcp)\s*\.\s*(?:exec|spawn|execSync|spawnSync|execFile)\b/g,
    fp: [],
    hint: "确认命令串来源与门禁；注意 promisify(childProcess.exec) 这种「传函数引用」也有执行能力",
  },

  /* —— 混淆 / 编码 —— */
  {
    id: "OBF-ATOB", family: "混淆", base: "MEDIUM", note: "atob/base64 解码",
    re: /(?<![.\w$])atob\s*\(|Buffer\.from\s*\([^)]*['"]base64['"]/g,
    fp: [/retType\s*:\s*['"]base64/, /encoding\s*:\s*['"]base64/],
    hint: "解码后若紧跟 eval/Function 才危险；本地签名算法（xbogus/abogus/DS）属良性",
  },
  {
    id: "OBF-CHARCODE", family: "混淆", base: "LOW", note: "fromCharCode 字符还原",
    re: /fromCharCode\s*\(/g,
    fp: [],
    hint: "常配合字符串数组还原，需结合上下文",
  },
  {
    id: "OBF-PACKER", family: "混淆", base: "MEDIUM", note: "疑似商用/自研混淆器",
    re: /_0x[0-9a-fA-F]{4,}|jsjiami|javascript-obfuscator|obfuscator\.io|RC4|v8\.deserialize/g,
    fp: [],
    hint: "混淆本身不等于后门；需解码后确认是本地功能（签名/SDK/协议）还是后门载体",
  },

  /* —— 硬编码凭据 —— */
  {
    id: "SEC-SK", family: "凭据", base: "HIGH", note: "疑似 OpenAI 类密钥",
    re: /\bsk-[A-Za-z0-9_-]{16,}/g,
    scope: "match",
    fp: [/sk-(?:xxx|test|your|placeholder|example|123456|abcdef)/i, /sk-\.\.\./, /sk-\$\{/],
    hint: "排除占位符后，真实个人密钥属红线；第三方公开 API 标识通常合规",
  },
  {
    id: "SEC-ASSIGN", family: "凭据", base: "MEDIUM", note: "凭据变量硬编码赋值",
    re: /(?:api[_-]?key|apikey|secret|token|password|passwd|cookie|bearer)\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}['"]/gi,
    scope: "match",
    fp: [/\$\{\{/, /process\.env/, /\b(?:xxx|your|placeholder|example|changeme|demo|test|null|none)\b/i],
    hint: "需人工区分：真实凭据 / 第三方公开标识 / 占位符 / 仅字段名",
  },
  {
    id: "SEC-AUTHZ", family: "凭据", base: "MEDIUM", note: "Authorization 头硬编码",
    re: /Authorization\s*[:=]\s*['"][^'"\s]{12,}['"]/g,
    scope: "match",
    fp: [/\$\{\{/, /process\.env/, /Bearer\s+\$\{/],
    hint: "同上",
  },

  /* —— 云崽特有 —— */
  {
    id: "YZ-MASTERHASH", family: "云崽特有", base: "CRITICAL", note: "对调用者 QQ 做哈希再比对",
    re: /(?:md5|sha1|sha256|createHash\([^)]*\))\s*\(\s*(?:String\s*\(\s*)?[\w.]*user_id/gi,
    fp: [],
    hint: "高度可疑的隐藏后门模式：硬编码主人 QQ 哈希、运行时比对放行。也可能是设备 ID 等正常业务哈希，必须人读源码确认",
  },
  {
    id: "YZ-HASH-LITERAL", family: "云崽特有", base: "MEDIUM", note: "32/40 位哈希字面量",
    re: /['"][a-f0-9]{32}['"]|['"][a-f0-9]{40}['"]/g,
    fp: [],
    hint: "若与 user_id/比对同现，可能是隐藏授权；版本哈希、设备指纹等属正常",
  },
  {
    id: "YZ-MASTERQQ", family: "云崽特有", base: "CRITICAL", note: "主人/管理名单里写死 QQ 号",
    re: /\b(?:masterQQ|adminQQ|masterList|masters|master)\s*[:=]\s*\[[^\]]*\]/g,
    fp: [/^\s*(?:\/\/|\/\*|\*)/, /示例|样例|example|placeholder|请修改|改成|如[:：]/i],
    hint: "只有方括号字面量里确有 QQ 形态数字才算；读取配置（cfg.masterQQ）本身完全正常",
    contextCheck: (lines, idx, m) => /\b[1-9]\d{4,10}\b/.test(m || ""),
  },

  /* —— 数据外联 —— */
  {
    id: "NET-BAREIP", family: "外联", base: "LOW", note: "裸 IP 外联",
    re: /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}/g,
    fp: [/127\.0\.0\.1|0\.0\.0\.0|localhost/, /^https?:\/\/(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./],
    hint: "内网/本机地址属正常；公网裸 IP 需确认用途",
  },
  {
    id: "NET-CREDOUT", family: "外联", base: "HIGH", note: "凭据与外发同现",
    re: /(?:axios|fetch|https?\.request|https?\.get|request\s*\()\s*\(/g,
    fp: [],
    hint: "同文件内既有凭据又有外发调用时升级；需人工确认是否把凭据发给第三方",
  },

  /* —— 其它 —— */
  {
    id: "MISC-PROTO", family: "其它", base: "MEDIUM", note: "原型链污染面",
    re: /__proto__\s*=|prototype\s*\[\s*['"`]/g,
    fp: [],
    hint: "确认键名是否可控",
  },
  {
    id: "FS-DELETE", family: "其它", base: "MEDIUM", note: "删除文件/目录",
    re: /\b(?:unlinkSync|rmSync|rmdirSync)\s*\(|\bfs(?:\.promises)?\s*\.\s*(?:unlink|rm|rmdir)\s*\(/g,
    fp: [],
    hint: "若删的是 data/ 下的数据文件需重点关注（云崽 fsGuard 会备份并通报）",
  },
];

/** npm 常见包名，用于距离 1 的仿冒提示（仅提示，需人工确认） */
const POPULAR_NPM = [
  "lodash", "axios", "chalk", "moment", "express", "request", "ws", "fs-extra",
  "yaml", "commander", "cheerio", "puppeteer", "redis", "mysql", "sqlite3",
  "dayjs", "uuid", "got", "node-fetch", "form-data", "qs", "ulid", "crypto-js",
];

/* ─────────────── 外部规则覆盖 / 导出 ─────────────── */

function compileRule(r) {
  const out = { ...r };
  out.re = r.re instanceof RegExp ? r.re : new RegExp(r.re, r.flags ?? "g");
  out.fp = (r.fp || []).map((f) => (f instanceof RegExp ? f : new RegExp(f)));
  return out;
}

if (opts.rules) {
  const ext = JSON.parse(fs.readFileSync(opts.rules, "utf8"));
  const incoming = (ext.rules || []).map(compileRule);
  if (ext.replace) {
    RULES.length = 0;
    RULES.push(...incoming);
  } else {
    for (const r of incoming) {
      const i = RULES.findIndex((x) => x.id === r.id);
      if (i >= 0) RULES[i] = r;
      else RULES.push(r);
    }
  }
  // disable：显式关掉某几条内置规则（比要求用户整份替换更安全）
  for (const id of ext.disable || []) {
    const i = RULES.findIndex((x) => x.id === id);
    if (i >= 0) RULES.splice(i, 1);
  }
}

if (opts.dumpRules) {
  const dump = {
    version: 1,
    replace: false,
    disable: [],
    note: "改完用 --rules <此文件> 回灌。replace=false 时按 id 覆盖（同 id 改内容、新 id 追加），disable 里列 id 可关掉内置规则；replace=true 则整份替换。re/fp 用字符串形式，flags 缺省 g。带 contextCheck 的内置规则导出后该逻辑会丢失。",
    rules: RULES.map((r) => ({
      id: r.id, family: r.family, base: r.base, note: r.note, hint: r.hint,
      re: r.re.source, flags: r.re.flags,
      fp: (r.fp || []).map((f) => f.source),
    })),
  };
  fs.writeFileSync(opts.dumpRules, JSON.stringify(dump, null, 2), "utf8");
  console.log(`已导出 ${dump.rules.length} 条规则 → ${opts.dumpRules}`);
  if (!targets.length) process.exit(0);
}

/* ─────────────── 工具函数 ─────────────── */

function walk(dir, out = [], linkDirs = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith(".") && e.isDirectory() && e.name !== ".github") continue;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      // 软链不能直接跳过：插件可以把代码放别处再用软链挂进来
      let st = null;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) linkDirs.push(p);
      else if (st.isFile()) out.push(p);
      continue;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out, linkDirs);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function wildcardMatch(pattern, s) {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === s;
  let rest = s;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    if (i === 0) {
      if (!rest.startsWith(part)) return false;
      rest = rest.slice(part.length);
    } else if (i === parts.length - 1) {
      return rest.endsWith(part);
    } else {
      const pos = rest.indexOf(part);
      if (pos < 0) return false;
      rest = rest.slice(pos + part.length);
    }
  }
  return true;
}

/** 文件 → profile 名；先匹配先生效 */
function routeProfile(relPath) {
  const base = relPath.split("/").pop().toLowerCase();
  for (const row of ROUTE) {
    if (row.pat.some((p) => wildcardMatch(p, base))) return row.profile;
  }
  return null;
}

function readText(p) {
  try {
    const st = fs.statSync(p);
    if (st.size > MAX_FILE_BYTES) return { text: null, reason: "large" };
    return { text: fs.readFileSync(p, "utf8"), reason: null };
  } catch {
    return { text: null, reason: "unreadable" };
  }
}

function gitInfo(dir) {
  const exec = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const head = exec(["rev-parse", "HEAD"]).trim();
    const date = exec(["log", "-1", "--format=%ci"]).trim();
    return { head: head.slice(0, 7), full: head, date, isGit: true };
  } catch {
    return { head: null, full: null, date: null, isGit: false };
  }
}

function editDistance1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return false;
  const la = a.toLowerCase(), lb = b.toLowerCase();
  if (la.length === lb.length) {
    let diff = 0;
    for (let i = 0; i < la.length; i++) if (la[i] !== lb[i] && ++diff > 1) return false;
    return diff === 1;
  }
  const [s, l] = la.length < lb.length ? [la, lb] : [lb, la];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; }
    else if (!skipped) { skipped = true; j++; }
    else return false;
  }
  return true;
}

/**
 * 增量范围：git diff <rev> 的新增行。
 * 返回 Map<相对路径, Set<新增行号>|null>（null = 整个文件都要扫，如未跟踪的新文件）。
 */
function diffScope(dir, rev) {
  let out;
  try {
    out = execFileSync("git", ["diff", "--unified=0", "--no-color", rev, "--"], {
      cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const msg = String(err.stderr || err.message).split("\n").filter(Boolean)[0] || "unknown";
    return { error: msg };
  }
  const files = new Map();
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p === "/dev/null") { cur = null; continue; }
      cur = p.replace(/^b\//, "");
      if (!files.has(cur)) files.set(cur, new Set());
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && cur) {
      const start = Number(m[1]);
      const cnt = m[2] === undefined ? 1 : Number(m[2]);
      for (let k = 0; k < cnt; k++) files.get(cur).add(start + k);
    }
  }
  try {
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: dir, encoding: "utf8",
    });
    for (const p of untracked.split("\n").filter(Boolean)) files.set(p, null);
  } catch { /* 忽略 */ }
  return { files };
}

/* ─────────────── 扫描 ─────────────── */

/** 用户输入被赋给哪些局部变量（一跳传播用，例如 const code = this.e.msg...） */
const RE_INPUT_ASSIGN = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?(?:e\.msg|e\.raw_message|e\.message|msg\.replace|msg\.trim)/g;
function collectInputVars(text) {
  const set = new Set();
  RE_INPUT_ASSIGN.lastIndex = 0;
  let m;
  while ((m = RE_INPUT_ASSIGN.exec(text)) !== null) set.add(m[1]);
  return set;
}

function scanFile(relPath, text, allowedLines, profile) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  const minified = lines.length <= 3 && text.length > 5000;
  const fams = PROFILES[profile] || PROFILES.code;
  for (const rule of RULES) {
    if (!fams.has(rule.family)) continue;
    for (let i = 0; i < lines.length; i++) {
      if (allowedLines && !allowedLines.has(i + 1)) continue;
      const line = lines[i];
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        // fp 默认作用于整行；标了 scope:"match" 的规则只作用于命中片段，
        // 否则「同一行里出现无关的 name:」会把真密钥整行吞掉
        const target = rule.scope === "match" ? m[0] : line;
        if (rule.fp && rule.fp.some((f) => f.test(target))) break;
        if (rule.contextCheck && !rule.contextCheck(lines, i, m[0], target)) break;
        hits.push({
          rule: rule.id, family: rule.family, base: rule.base,
          sink: rule.sink !== false, minified,
          line: i + 1, text: line.trim().slice(0, 200), note: rule.note, hint: rule.hint,
        });
        break;
      }
    }
  }
  return {
    hits, minified,
    hasInput: RE_INPUT.test(text), hasGate: RE_GATE.test(text),
    inputVars: collectInputVars(text),
  };
}

/** 取出从 startIdx 起的函数体（按花括号配平，最多 60 行） */
function extractBody(lines, startIdx) {
  if (!lines[startIdx].includes("{")) return lines[startIdx];
  let depth = 0, started = false;
  const body = [];
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 60); i++) {
    const l = lines[i];
    for (const ch of l) {
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") depth--;
    }
    body.push(l);
    if (started && depth <= 0) break;
  }
  return body.join("\n");
}

const DEF_NAME = /(?:sanitiz|escape|escStr|validat|verif|purif|clean|filter|safe(?:Str|Input|Name|Path)|校验|过滤|清洗|净化|安全处理)/i;

/**
 * 「无效防御」检查：名字声称做了校验/转义/清洗，函数体却是空转或原样返回。
 * 这类假防御比"没有防御"更危险——调用方以为已经安全了。
 */
function scanIneffectiveDefense(relPath, text, allowedLines) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  const decls = [
    /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/,
    /^\s*(?:public\s+|private\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/,
  ];
  for (let i = 0; i < lines.length; i++) {
    if (allowedLines && !allowedLines.has(i + 1)) continue;
    let name = null, params = "";
    for (const re of decls) {
      const m = re.exec(lines[i]);
      if (m) { name = m[1]; params = m[2] || ""; break; }
    }
    if (!name || !DEF_NAME.test(name)) continue;

    const body = extractBody(lines, i);
    const stripped = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    let inner;
    if (stripped.includes("{")) {
      inner = stripped.slice(stripped.indexOf("{") + 1).replace(/\}\s*$/, "").trim();
    } else {
      // 无花括号的箭头函数：(p) => p
      const arrow = stripped.indexOf("=>");
      inner = (arrow >= 0 ? stripped.slice(arrow + 2) : "").trim().replace(/;$/, "");
    }
    const param = (params.split(",")[0] || "").trim().split(/[=:]/)[0].trim();

    const reasons = [];
    if (!inner) reasons.push("函数体为空");
    else if (param && inner === param) reasons.push(`原样返回入参 ${param}，未做任何处理`);
    else if (param && new RegExp(`^return\\s+${param.replace(/[$]/g, "\\$")}\\s*;?$`).test(inner)) {
      reasons.push(`原样返回入参 ${param}，未做任何处理`);
    }
    if (/new\s+RegExp\s*\(\s*(['"])\1\s*\)/.test(stripped)) reasons.push("用了空正则 new RegExp('')");
    if (/\breplace\s*\(\s*([^,()]+?)\s*,\s*\1\s*\)/.test(stripped)) reasons.push("replace 的替换值与匹配值相同");

    if (!reasons.length) continue;
    hits.push({
      rule: "DEF-NOOP", family: "防御", base: "MEDIUM",
      line: i + 1, text: lines[i].trim().slice(0, 200),
      note: "名不副实的防御函数",
      hint: `${reasons.join("；")} —— 名字声称做了校验/转义，实际没有。这类「假防御」比没有防御更危险，需人工确认调用方是否依赖它`,
    });
  }
  return hits;
}

/**
 * S3：可达性分诊（不是完整的「数据流」）
 * 判据只有两层：① sink 所在行是否直接出现输入（含一跳变量）；② 文件内有无门禁。
 * 声称"数据流"是不诚实的——跨函数、经文件/Redis 的多跳传播看不到，已列入盲区。
 */
function triage(fileRel, meta, defHits, filesWithCred) {
  const out = [];
  const esc = (v) => v.replace(/[$]/g, "\\$");

  for (const h of [...meta.hits, ...defHits]) {
    let level = h.base;
    const why = [];

    if (h.family === "RCE") {
      // 邻近：sink 行内直接出现输入源，或出现由输入源赋值的局部变量（一跳）
      const near = RE_INPUT.test(h.text) ||
        [...meta.inputVars].some((v) => new RegExp(`\\b${esc(v)}\\b`).test(h.text));

      if (!h.sink) {
        level = "MEDIUM";
        why.push("只是具备执行能力（import/require），本行未见 sink 调用；不按 RCE 升级");
      } else if (near) {
        why.push("sink 行内直接出现用户输入（邻近命中）");
        if (!meta.hasGate) {
          level = "CRITICAL";
          why.push("同文件未发现主人/权限门禁（门禁可能在上层调用方，需人工确认）");
        } else {
          level = "HIGH";
          why.push("文件内有门禁痕迹，需确认是否覆盖该入口");
        }
      } else if (meta.hasInput) {
        level = "HIGH";
        why.push("同文件有输入源，但不在该 sink 邻近/一跳内 —— 疑似，需人读确认是否可达");
      } else {
        level = "MEDIUM";
        why.push("未见用户输入源，可能为配置/常量驱动，需确认来源");
      }
    }

    if (h.rule === "NET-CREDOUT") {
      if (!filesWithCred.has(fileRel)) continue;
      if (/(?:header|headers|params|data\s*:|body\s*:|Authorization|token|api[_-]?key|secret)/i.test(h.text)) {
        level = "HIGH";
        why.push("同文件既有凭据、外发调用的参数里也出现凭据相关字段");
      } else {
        level = "MEDIUM";
        why.push("同文件有凭据与外发，但该调用未见凭据参数 —— 只是共现，未证明外传");
      }
    }

    if (h.rule === "FS-DELETE" && RE_DATA_PATH.test(h.text)) {
      level = "HIGH";
      why.push("删除目标路径涉及 data/");
    }

    if (h.minified && h.family === "混淆") {
      level = "MEDIUM";
      why.push("命中位于压缩/打包文件（单行超长），多为第三方库；不能当无事发生，也不能当后门");
    }

    if (h.family === "云崽特有" && h.base === "CRITICAL") {
      why.push("云崽特有高危模式，必须人读源码定性");
    }

    out.push({ ...h, level, why, file: fileRel });
  }
  return out;
}

function audit(target) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return { error: `路径不存在: ${abs}` };

  const git = gitInfo(abs);
  const scope = opts.since ? diffScope(abs, opts.since) : null;
  const linkDirs = [];
  const allFiles = walk(abs, [], linkDirs);
  const scannable = allFiles.filter((p) => SCAN_EXT.has(path.extname(p).toLowerCase()));
  const binaries = allFiles.filter((p) => BINARY_EXT.has(path.extname(p).toLowerCase()));

  const findings = [];
  const filesWithCred = new Set();
  const skipped = linkDirs.map((d) => ({ file: path.relative(abs, d).replace(/\\/g, "/"), reason: "symlink-dir" }));
  const byProfile = { code: 0, config: 0, doc: 0, pkg: 0, skip: 0 };
  let scannedFiles = 0;
  let scopeFiles = 0;

  const fileMeta = new Map();
  for (const p of scannable) {
    const rel = path.relative(abs, p).replace(/\\/g, "/");
    const profile = routeProfile(rel);
    if (profile === "skip") { byProfile.skip++; continue; }

    let allowed = null;
    if (scope && scope.files) {
      const sc = scope.files.get(rel);
      if (sc === undefined) continue;
      allowed = sc;
      if (allowed && allowed.size === 0) continue;
      scopeFiles++;
    }

    const { text, reason } = readText(p);
    if (text === null) { skipped.push({ file: rel, reason }); continue; }
    const meta = scanFile(rel, text, allowed, profile);
    const defHits = profile === "code" ? scanIneffectiveDefense(rel, text, allowed) : [];
    fileMeta.set(rel, { meta, defHits });
    byProfile[profile] = (byProfile[profile] || 0) + 1;
    scannedFiles++;
    if (meta.hits.some((h) => h.family === "凭据")) filesWithCred.add(rel);
  }

  for (const [rel, { meta, defHits }] of fileMeta) {
    findings.push(...triage(rel, meta, defHits, filesWithCred));
  }

  /* —— S1：供应链与资产 —— */
  const pkgPaths = allFiles.filter((p) => path.basename(p) === "package.json" && !p.includes("node_modules"));
  const supply = [];
  for (const p of pkgPaths) {
    const rel = path.relative(abs, p).replace(/\\/g, "/");
    if (scope && scope.files && !scope.files.has(rel)) continue;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
    const scripts = pkg.scripts || {};
    for (const k of ["preinstall", "install", "postinstall", "prepublish", "prepare"]) {
      if (scripts[k]) {
        supply.push({
          level: "MEDIUM", rule: "SUPPLY-HOOK", family: "供应链", file: rel,
          line: 0, text: `${k}: ${scripts[k]}`, note: "安装期执行脚本",
          hint: "确认脚本内容是否下载/执行远端代码", why: ["安装钩子可被用于供应链投毒"],
        });
      }
    }
    for (const [name, ver] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (/^(?:git|https?):/.test(String(ver))) {
        supply.push({
          level: "MEDIUM", rule: "SUPPLY-GITDEP", family: "供应链", file: rel,
          line: 0, text: `${name}: ${ver}`, note: "依赖来自 git/URL 而非 npm registry",
          hint: "远端依赖不受 npm 审计约束", why: ["需核对目标仓库可信度"],
        });
      }
      // 本身就在常用包名单里的不算仿冒（editDistance1("qs","ws") 会误伤真包）
      if (!POPULAR_NPM.includes(name.toLowerCase()) && name.length >= 4 &&
          POPULAR_NPM.some((pop) => editDistance1(name, pop))) {
        supply.push({
          level: "LOW", rule: "SUPPLY-TYPOSQUAT", family: "供应链", file: rel,
          line: 0, text: `${name}: ${ver}`, note: "包名与常用包近似（仿冒嫌疑）",
          hint: "绝大多数是误报（fs/qs/ws/ulid 之类短名），人工确认即可", why: ["需人工确认"],
        });
      }
    }
  }

  for (const p of binaries) {
    const rel = path.relative(abs, p).replace(/\\/g, "/");
    if (scope && scope.files && !scope.files.has(rel)) continue;
    supply.push({
      level: "LOW", rule: "ASSET-BINARY", family: "资产", file: rel, line: 0,
      text: rel, note: "原生二进制（不可静态审计）",
      hint: "闭源二进制内部行为无法静态判定", why: ["需披露"],
    });
  }

  const all = [...findings, ...supply];
  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  all.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9) || a.file.localeCompare(b.file) || a.line - b.line);

  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of all) counts[f.level] = (counts[f.level] || 0) + 1;

  return {
    target: abs,
    name: path.basename(abs),
    git,
    scope: scope ? { rev: opts.since, files: scopeFiles, error: scope.error } : null,
    stats: { totalFiles: allFiles.length, scannedFiles, scannable: scannable.length, byProfile, skipped },
    counts,
    findings: all,
  };
}

/* ─────────────── 棘轮 ─────────────── */

const fp = (f) => `${f.rule}|${f.file}`;

function applyRatchet(results) {
  const file = path.resolve(opts.ratchet);
  let db = { version: 1, plugins: {} };
  if (fs.existsSync(file)) {
    try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch { db = { version: 1, plugins: {} }; }
  }
  db.plugins = db.plugins || {};
  const out = [];

  for (const r of results) {
    if (r.error) continue;
    const cur = new Set(r.findings.map(fp));
    const base = db.plugins[r.name];
    if (!base) {
      db.plugins[r.name] = {
        head: r.git.head, date: new Date().toISOString().slice(0, 10),
        counts: r.counts, findings: [...cur].sort(),
      };
      out.push({ name: r.name, status: "created", added: [], fixed: 0 });
      continue;
    }
    const baseSet = new Set(base.findings || []);
    const added = [...cur].filter((x) => !baseSet.has(x));
    const fixed = [...baseSet].filter((x) => !cur.has(x));

    if (added.length && !opts.accept) {
      out.push({ name: r.name, status: "regressed", added, fixed: fixed.length });
    } else {
      db.plugins[r.name] = {
        head: r.git.head, date: new Date().toISOString().slice(0, 10),
        counts: r.counts, findings: [...cur].sort(),
      };
      out.push({ name: r.name, status: added.length ? "accepted" : "ok", added, fixed: fixed.length });
    }
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(db, null, 1), "utf8");
  return { file, results: out };
}

/* ─────────────── 输出 ─────────────── */

const BLIND_SPOTS = [
  "可达性只算「邻近 + 一跳变量」：sink 参数经多层函数传递、或经文件/Redis 中转（例如先把用户代码写进文件、再把文件喂给 docker）看不到，此类必须人读",
  "运行时行为：远程下发授权列表、运行时下载后执行、依赖链深层钩子——静态看不到，需动态沙箱",
  "混淆语义：本工具只能报「存在混淆/编码」，解码后是本地签名算法还是后门载体，必须人读源码定性",
  "门禁位置：门禁判定以「同文件」为单位，若门禁在上层调用方（如统一 rule 注册处）会误判为无门禁",
  "闭源二进制：只登记存在，不分析内部行为",
  "社工类：钓鱼话术、冒充官方、二维码劫持属运行行为与人工判定范畴，grep 抓不到",
  "本工具不联网：上游 HEAD 是否变更、依赖是否有 CVE 通告，需另跑 git ls-remote / npm audit",
  "增量模式（--since）只看改动行：改动行引用的旧变量/门禁可能不在扫描范围内",
  "「无效防御」是启发式：只能识别空转、原样返回、空正则、自替换这几类，判定仍需人读",
  "压缩/打包文件里的混淆命中只降级不做判断，需确认是第三方库还是自打包",
];

function renderTerminal(r) {
  if (r.error) { console.log(`\n[错误] ${r.error}`); return; }
  const L = [];
  L.push(`\n===== ${r.name} =====`);
  L.push(`  路径   ${r.target}`);
  L.push(`  版本   ${r.git.isGit ? `${r.git.head} (${r.git.date})` : "非 git 目录，哈希待核"}`);
  L.push(`  模式   ${r.scope ? `增量（自 ${r.scope.rev}）：变更文件 ${r.scope.files} 个${r.scope.error ? `（diff 失败：${r.scope.error}，未做增量过滤）` : ""}` : "全量"}`);
  L.push(`  规模   文件 ${r.stats.totalFiles}，已扫 ${r.stats.scannedFiles}/${r.stats.scannable}` +
    `（code ${r.stats.byProfile.code || 0} / config ${r.stats.byProfile.config || 0} / doc ${r.stats.byProfile.doc || 0} / 低信号跳过 ${r.stats.byProfile.skip || 0}）`);
  L.push(`  结论   CRITICAL ${r.counts.CRITICAL} | HIGH ${r.counts.HIGH} | MEDIUM ${r.counts.MEDIUM} | LOW ${r.counts.LOW}`);
  if (r.stats.skipped.length) {
    L.push(`  未扫   ${r.stats.skipped.length} 个（过大 / 不可读 / 软链目录），明细见报告`);
  }

  const shown = r.findings.slice(0, opts.top);
  if (!shown.length) L.push(`\n  未发现命中。`);
  for (const f of shown) {
    L.push(`\n  [${f.level}] ${f.rule}  ${f.file}${f.line ? ":" + f.line : ""}`);
    if (f.text) L.push(`      ${f.text.length > 150 ? f.text.slice(0, 150) + "…" : f.text}`);
    if (f.why?.length) L.push(`      判定：${f.why.join("；")}`);
  }
  if (r.findings.length > shown.length) L.push(`\n  …另有 ${r.findings.length - shown.length} 条，见报告文件`);
  console.log(L.join("\n"));
}

/** Markdown 单元格转义：反引号会截断行内代码，竖线会破坏表格 */
const mdCell = (s) => String(s || "").replace(/`/g, "'").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function renderMarkdown(r, ratchetInfo) {
  const L = [];
  L.push(`# 插件安全审计报告：${r.name}`);
  L.push("");
  L.push(`- 路径：\`${r.target}\``);
  L.push(`- 版本：${r.git.isGit ? `\`${r.git.head}\` (${r.git.date})` : "非 git 目录，哈希待核"}`);
  L.push(`- 模式：${r.scope ? `增量（自 \`${r.scope.rev}\`，变更文件 ${r.scope.files}）` : "全量"}`);
  L.push(`- 规模：文件 ${r.stats.totalFiles}，已扫 ${r.stats.scannedFiles}/${r.stats.scannable}`);
  L.push(`- 审查日期：${new Date().toISOString().slice(0, 10)}`);
  L.push(`- 结论：**CRITICAL ${r.counts.CRITICAL} / HIGH ${r.counts.HIGH} / MEDIUM ${r.counts.MEDIUM} / LOW ${r.counts.LOW}**`);
  if (ratchetInfo) {
    const map = { created: "建立基线", ok: "通过（无新增）", regressed: "**判红：出现新增命中**", accepted: "已接受为新基线" };
    L.push(`- 棘轮：${map[ratchetInfo.status] || ratchetInfo.status}` +
      (ratchetInfo.added?.length ? `，新增 ${ratchetInfo.added.length} 条` : "") +
      (ratchetInfo.fixed ? `，修复 ${ratchetInfo.fixed} 条` : ""));
  }
  L.push("");

  const byLevel = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
  const cap = opts.allMd ? Infinity : 60;
  for (const lv of byLevel) {
    const group = r.findings.filter((f) => f.level === lv);
    if (!group.length) continue;
    L.push(`## ${lv}（${group.length}）`);
    L.push("");
    L.push("| 规则 | 位置 | 命中内容 | 判定依据 |");
    L.push("| --- | --- | --- | --- |");
    for (const f of group.slice(0, cap)) {
      const txt = mdCell((f.text || "").slice(0, 110));
      const basis = mdCell([(f.why || []).join("；"), f.hint || ""].filter(Boolean).join(" —— "));
      L.push(`| ${f.rule} | \`${mdCell(f.file)}${f.line ? ":" + f.line : ""}\` | \`${txt}\` | ${basis} |`);
    }
    if (group.length > cap) L.push(`\n_（该级别另有 ${group.length - cap} 条，加 \`--all-md\` 展开）_`);
    L.push("");
  }

  if (ratchetInfo?.added?.length) {
    L.push("## 棘轮：本次新增的命中");
    L.push("");
    for (const a of ratchetInfo.added.slice(0, 50)) L.push(`- \`${a}\``);
    L.push("");
  }

  if (r.stats.skipped.length) {
    L.push("## 未扫描文件");
    L.push("");
    for (const s of r.stats.skipped.slice(0, 20)) L.push(`- \`${s.file}\`（${s.reason === "large" ? "超过 1.5MB" : "不可读"}）`);
    L.push("");
  }

  L.push("## 残留盲区（本工具无法覆盖）");
  L.push("");
  for (const b of BLIND_SPOTS) L.push(`- ${b}`);
  L.push("");
  L.push("## 复现命令");
  L.push("");
  L.push("```bash");
  L.push(`node tools/plugin-audit.mjs "${r.target}"${r.scope ? ` --since ${r.scope.rev}` : ""} --md audit-${r.name}.md --top 20`);
  L.push("```");
  L.push("");
  return L.join("\n");
}

/* ─────────────── 主流程 ─────────────── */

const results = targets.map(audit);
for (const r of results) renderTerminal(r);

if (results.length) {
  const tot = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const r of results) if (!r.error) for (const k of Object.keys(tot)) tot[k] += r.counts[k] || 0;
  console.log(`\n===== 合计 =====`);
  console.log(`  CRITICAL ${tot.CRITICAL} | HIGH ${tot.HIGH} | MEDIUM ${tot.MEDIUM} | LOW ${tot.LOW}`);
  console.log(`  提示：CRITICAL/HIGH 必须人读源码定性；本工具负责把候选筛出来，不做最终判定。`);
}

let ratchet = null;
if (opts.failOn) {
  const want = String(opts.failOn).toLowerCase();
  const atLeast = { critical: ["CRITICAL"], high: ["CRITICAL", "HIGH"], medium: ["CRITICAL", "HIGH", "MEDIUM"], low: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] };
  const levels = atLeast[want];
  if (!levels) {
    console.error(`\n[用法错误] --fail-on 只支持 critical|high|medium|low，收到: ${opts.failOn}`);
    process.exitCode = 2;
  } else {
    const bad = results.filter((r) => !r.error).filter((r) => levels.some((lv) => (r.counts[lv] || 0) > 0));
    if (bad.length) {
      console.log(`\n===== 门禁（--fail-on ${want}）=====`);
      console.log(`  ✗ ${bad.map((r) => r.name).join(", ")} 命中 ${levels.join("/")} 级问题`);
      process.exitCode = 1;
    } else {
      console.log(`\n===== 门禁（--fail-on ${want}）=====\n  ✓ 未触及阈值`);
    }
  }
}
if (opts.ratchet) {
  ratchet = applyRatchet(results);
  console.log(`\n===== 棘轮门禁 =====`);
  for (const x of ratchet.results) {
    if (x.status === "regressed") {
      console.log(`  ✗ ${x.name}：新增 ${x.added.length} 条（基线未动，需修复或用 --accept 显式接受）`);
      for (const a of x.added.slice(0, 20)) console.log(`      + ${a}`);
      if (x.added.length > 20) console.log(`      …另 ${x.added.length - 20} 条`);
      process.exitCode = 1;
    } else if (x.status === "created") {
      console.log(`  ⊙ ${x.name}：建立基线`);
    } else if (x.status === "accepted") {
      console.log(`  ! ${x.name}：已接受 ${x.added.length} 条新增为新基线（--accept）`);
    } else {
      console.log(`  ✓ ${x.name}：无新增${x.fixed ? `，修复 ${x.fixed} 条（基线已下调）` : ""}`);
    }
  }
  console.log(`  基线文件：${ratchet.file}`);
}

if (!opts.noMd) {
  const used = new Set();
  const day = new Date().toISOString().slice(0, 10);
  for (const r of results) {
    if (r.error) continue;
    let out;
    if (opts.md && results.length === 1) {
      out = path.resolve(opts.md);
    } else if (opts.md) {
      // 多目标时 --md 当作"前缀"：<目录>/<前缀>-<插件名>.md，不再被静默忽略
      const absMd = path.resolve(opts.md);
      const ext = path.extname(absMd) || ".md";
      const stem = path.basename(absMd, ext);
      out = path.join(path.dirname(absMd), `${stem}-${r.name}${ext}`);
    } else {
      // 默认收到 audit-reports/，不污染当前目录
      out = path.resolve("audit-reports", `audit-${r.name}-${day}.md`);
    }
    // 同名插件（两个目录都叫 plugin）不能互相覆盖
    const base = out;
    let n = 1;
    while (used.has(out)) {
      const ext = path.extname(base);
      out = `${base.slice(0, -ext.length)}-${++n}${ext}`;
    }
    used.add(out);
    const info = ratchet?.results.find((x) => x.name === r.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderMarkdown(r, info), "utf8");
    console.log(`  报告：${out}`);
  }
}

if (opts.json) {
  fs.writeFileSync(opts.json, JSON.stringify({ results, ratchet }, null, 1), "utf8");
  console.log(`  JSON：${opts.json}`);
}
