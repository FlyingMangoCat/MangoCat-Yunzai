import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { resolveBackdoorQQ } from "../config/pluginScan.js"
import { inspectScriptText, stripScriptComments } from "./commandPatterns.js"
import { isNeverAllowRule } from "./auditPolicy.js"

/**
 * 插件静态特征审计
 *
 * 只读扫描插件目录，不执行插件代码、不写插件文件。每条命中都是一个独立
 * finding；loader 只负责把 block 级 finding 转为禁止加载，其余交给 findingLog
 * 逐条记录/通报。规则按“证据强度 + 权限/核心/外发语境”判级。
 */

const CODE_EXT = new Set([".js", ".mjs", ".cjs"])
const BINARY_EXT = new Set([".node", ".exe", ".dll", ".so", ".dylib", ".jar", ".pyc", ".wasm", ".msi"])
const SCRIPT_EXT = new Set([".bat", ".cmd", ".ps1", ".sh"])
const MAX_CODE_SIZE = 2 * 1024 * 1024
const MAX_FINDINGS_PER_FILE = 120
// silent/notify/block 分开计数：任何一类都不能把另一类挤掉
const MAX_SILENT_FINDINGS_PER_FILE = 200
const MAX_BLOCK_FINDINGS_PER_FILE = 200
// 测试文件正常扫描，仅把测试环境常见的执行/混淆噪音降为不记录
const TEST_SILENT_RULES = new Set([
  "exec.dynamic-code",
  "obfuscation.detected",
  "exec.child-process",
  "exec.fork",
  "exec.git-argument",
  "supply.auto-update",
  "auth.fixed-id",
  "auth.fixed-id-list",
])

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex")
}

function fileHashOf(file) {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return ""
  }
}

function clip(value, max = 800) {
  const text = String(value ?? "")
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function lineOf(source, index) {
  if (!Number.isFinite(index) || index < 0) return 0
  return source.slice(0, index).split("\n").length
}

function lineText(source, index) {
  if (!Number.isFinite(index) || index < 0) return ""
  const start = source.lastIndexOf("\n", index) + 1
  const end = source.indexOf("\n", index)
  return source.slice(start, end === -1 ? source.length : end).trim()
}

function contextOf(source, index, radius = 280) {
  return source.slice(Math.max(0, index - radius), Math.min(source.length, index + radius))
}

/** 压缩/第三方 SDK 包：仍然扫描，但动态执行类只记录，避免正常指纹/SDK 被拦 */
function isVendorBundle(rel) {
  return (
    /(?:^|[\\/])[^/\\]+\.(?:min|sdk|bundle)\.js$/i.test(rel) ||
    /(?:^|[\\/])(?:vendor|third[-_]?party|sdk)[\\/]/i.test(rel)
  )
}

function isTestFile(rel) {
  return /(?:^|[\\/])(?:test|tests|__tests__)(?:[\\/]|$)|(?:^|[\\/])test(?:[-_.][^\\/]*)?\.(?:js|mjs|cjs)$|\.(?:test|spec)\.(?:js|mjs|cjs)$/i.test(rel)
}

function permissionContext(text) {
  return /\b(?:isMaster|master|permission|privilege|admin|update|whiteList|blackList|checkBlack)\b/i.test(text)
}

/** 只有明确的主人/隐藏授权语境才按“未知主人”拦截；普通管理员/群白名单只记录 */
function masterContext(text) {
  return /\b(?:isMaster|masterQQ|master|主人|filtPermission)\b/i.test(text)
}

function walk(dir, out = [], depth = 0) {
  if (depth > 20) return out
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, out, depth + 1)
    else if (ent.isFile()) out.push(full)
  }
  return out
}

function decodeEvidence(raw) {
  const text = String(raw || "")
  const original = clip(text)
  const atob = text.match(/atob\(\s*["']([^"']+)["']\s*\)/i)
  if (atob) {
    try {
      const decoded = Buffer.from(atob[1], "base64").toString("utf8")
      return { mode: "decoded", text: clip(decoded), original, method: "atob/base64", hash: sha256(atob[1]) }
    } catch {}
  }
  const b64 = text.match(/Buffer\.from\(\s*["']([^"']+)["']\s*,\s*["']base64["']\s*\)/i)
  if (b64) {
    try {
      const decoded = Buffer.from(b64[1], "base64").toString("utf8")
      return { mode: "decoded", text: clip(decoded), original, method: "Buffer.from(base64)", hash: sha256(b64[1]) }
    } catch {}
  }
  const charCodes = [...text.matchAll(/String\.fromCharCode\(\s*([0-9,\s]+)\s*\)/gi)]
  if (charCodes.length) {
    try {
      const decoded = charCodes
        .map((m) => String.fromCharCode(...m[1].split(",").map((n) => Number(n.trim())).filter(Number.isFinite)))
        .join("")
      return { mode: "decoded", text: clip(decoded), original, method: "String.fromCharCode", hash: sha256(original) }
    } catch {}
  }
  const hex = text.match(/["']([0-9a-fA-F]{32,64})["']/)
  if (hex) return { mode: "decoded", text: `哈希/十六进制：${hex[1]}`, original, method: "hex 字面量", hash: hex[1] }
  return { mode: "raw", original }
}

function makeFinding(ctx, input) {
  return {
    plugin: ctx.name,
    ruleId: input.ruleId,
    level: input.level === "silent" ? "silent" : input.level === "block" ? "block" : "notify",
    category: input.category,
    file: ctx.rel,
    line: input.line || 0,
    fileHash: ctx.fileHash,
    summary: input.summary,
    operation: input.operation || input.summary,
    evidence: input.evidence || { mode: "raw", original: "" },
  }
}

function auditSource(ctx) {
  const { source, root } = ctx
  const out = []
  const seen = new Set()
  let silent = 0
  let notified = 0
  let blocks = 0
  const push = (input) => {
    const key = `${input.ruleId}:${input.line}:${input.evidence?.text || input.evidence?.original || ""}`
    if (seen.has(key)) return
    const level = input.level === "block" ? "block" : input.level === "silent" ? "silent" : "notify"
    if (level === "block") {
      if (blocks >= MAX_BLOCK_FINDINGS_PER_FILE) return
      blocks++
    } else if (level === "silent") {
      if (silent >= MAX_SILENT_FINDINGS_PER_FILE) return
      silent++
    } else {
      if (notified >= MAX_FINDINGS_PER_FILE) return
      notified++
    }
    seen.add(key)
    out.push(makeFinding(ctx, input))
  }
  const matches = (re) => [...source.matchAll(re)]

  // 1. TRSS 式内联模块
  for (const m of matches(/data:text\/javascript/gi)) {
    push({
      ruleId: "exec.inline-data-module",
      level: "block",
      category: "backdoor",
      line: lineOf(source, m.index),
      summary: "检测到 data:text/javascript 内联模块",
      operation: "加载内联隐藏代码",
      evidence: decodeEvidence(lineText(source, m.index)),
    })
  }

  // 2. 已知后门哈希/QQ、隐藏授权文件
  const known = /data:text\/javascript|Buffer\.from|v8\.deserialize/i.test(source)
    ? resolveBackdoorQQ(source, root)
    : { qqs: [], hashes: [] }
  if (known.qqs.length || known.hashes.length) {
    const at = source.search(/data:text\/javascript|Buffer\.from|v8\.deserialize|toString\(\s*["']hex/i)
    push({
      ruleId: "auth.known-backdoor",
      level: "block",
      category: "backdoor",
      line: at < 0 ? 0 : lineOf(source, at),
      summary: "命中已知后门哈希或隐藏授权 QQ",
      operation: "隐藏身份获取主人权限",
      evidence: {
        mode: "decoded",
        text: known.qqs.length ? `隐藏管理员 QQ：${known.qqs.join("、")}` : "未知的后门哈希",
        method: "已知哈希映射 / 隐藏授权文件",
        hash: known.hashes.join("、"),
        original: at < 0 ? "" : lineText(source, at),
      },
    })
  }

  // 3. 哈希授权比较
  for (const m of matches(/[_$\w]+\s*\(\s*String\s*\(\s*[^)\n]*user_id[^)\n]*\)\s*\)\s*(?:==|===|!=|!==)\s*["'][0-9a-fA-F]{32,64}["']/gi)) {
    push({
      ruleId: "auth.hash-compare",
      level: "block",
      category: "backdoor",
      line: lineOf(source, m.index),
      summary: "user_id 哈希与硬编码哈希比较",
      operation: "隐藏身份获取主人权限",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }

  // 4. yenai 隐藏授权文件
  if (/v8\.deserialize\s*\([^)]*readFile/i.test(source) && /\.includes\(\s*(?:md5|sha1|sha256|sha512)\s*\(\s*String\s*\(/i.test(source)) {
    const at = source.search(/v8\.deserialize/i)
    push({
      ruleId: "auth.deserialize-hidden",
      level: "block",
      category: "backdoor",
      line: lineOf(source, at),
      summary: "v8.deserialize 读取隐藏授权文件 + includes(md5)",
      operation: "隐藏身份获取主人权限",
      evidence: { mode: "plain", text: lineText(source, at) },
    })
  }

  // 5. 显式提权
  for (const m of matches(/\b(?:this\.)?e\.isMaster\s*=\s*true|\bisMaster\s*=\s*true/gi)) {
    push({
      ruleId: "auth.master-assign",
      level: "silent",
      category: "auth",
      line: lineOf(source, m.index),
      summary: "代码显式设置 e.isMaster = true",
      operation: "运行时将由 isMaster 锁定器拦截非配置主人提升",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }
  for (const m of matches(/\b(?:filtPermission|checkBlack)\s*=/gi)) {
    push({
      ruleId: "auth.permission-override",
      level: "block",
      category: "auth",
      line: lineOf(source, m.index),
      summary: "改写权限/过滤判断",
      operation: "绕过权限或黑名单",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }

  // 6. 固定 QQ / ID 权限判断
  const idTarget = "(?:user_id|userId|self_id|group_id|channel_id)"
  const idRef = `(?:[A-Za-z_$][\\w$]*\\.)*${idTarget}`
  const idCompare = new RegExp(
    `\\b(?:String|Number|parseInt|parseFloat)\\s*\\(\\s*${idRef}\\s*\\)\\s*(?:==|===|!=|!==)\\s*["']?\\d{5,12}["']?|\\b${idRef}\\s*(?:==|===|!=|!==)\\s*["']?\\d{5,12}["']?`,
    "gi",
  )
  for (const m of matches(idCompare)) {
    const master = masterContext(contextOf(source, m.index))
    const userLevel = /\b(?:user_id|userId|self_id)\b/.test(m[0])
    // 主人语境直接拦截；普通用户固定 ID 属不确定行为，提示复核；群号特判只记录
    const level = master ? "block" : userLevel ? "notify" : "silent"
    push({
      ruleId: "auth.fixed-id",
      level,
      category: "auth",
      line: lineOf(source, m.index),
      summary: "固定 QQ/ID 直接比较",
      operation: master ? "固定身份绕过权限/过滤" : userLevel ? "固定用户身份特判，需人工确认" : "固定群组身份特判",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }

  // 6a. toString() 比较 / switch 固定 ID
  const idToString = /\b(?:user_id|userId|self_id|group_id|channel_id)\s*\.\s*toString\s*\(\s*\)\s*(?:==|===|!=|!==)\s*["']?\d{5,12}["']?/gi
  for (const m of matches(idToString)) {
    const master = masterContext(contextOf(source, m.index))
    const userLevel = /\b(?:user_id|userId|self_id)\b/.test(m[0])
    const level = master ? "block" : userLevel ? "notify" : "silent"
    push({
      ruleId: "auth.fixed-id",
      level,
      category: "auth",
      line: lineOf(source, m.index),
      summary: "toString() 固定 QQ/ID 比较",
      operation: master ? "固定身份绕过权限/过滤" : userLevel ? "固定用户身份特判，需人工确认" : "固定群组身份特判",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }
  for (const m of matches(/\bswitch\s*\(([^{]{0,200})\{/gi)) {
    if (!/\b(?:user_id|userId|self_id|group_id|channel_id)\b/.test(m[1])) continue
    if (!/\bcase\s*["']?\d{5,12}["']?\s*:/.test(source.slice(m.index, m.index + 3000))) continue
    const master = masterContext(contextOf(source, m.index))
    const userLevel = /\b(?:user_id|userId|self_id)\b/.test(m[1])
    const level = master ? "block" : userLevel ? "notify" : "silent"
    push({
      ruleId: "auth.fixed-id",
      level,
      category: "auth",
      line: lineOf(source, m.index),
      summary: "switch 固定 QQ/ID 分支",
      operation: master ? "固定身份绕过权限/过滤" : userLevel ? "固定用户身份特判，需人工确认" : "固定群组身份特判",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }

  // 6b. 解码后的 QQ/ID 直接比较（如 atob("...") == user_id）
  for (const m of matches(/(?:\b(?:user_id|userId|self_id|group_id|channel_id)\s*(?:==|===|!=|!==)\s*(?:atob|Buffer\.from|String\.fromCharCode))|(?:(?:atob|Buffer\.from|String\.fromCharCode)\s*\([^)]*\)\s*(?:==|===|!=|!==)\s*(?:[A-Za-z_$][\w$]*\.)*(?:user_id|userId|self_id|group_id|channel_id))/gi)) {
    push({
      ruleId: "auth.decoded-id",
      level: "block",
      category: "backdoor",
      line: lineOf(source, m.index),
      summary: "固定 QQ/ID 经过解码后参与身份判断",
      operation: "隐藏身份绕过权限/过滤",
      evidence: decodeEvidence(lineText(source, m.index)),
    })
  }

  // 6c. 哈希先存变量再参与授权比较
  const hashVarRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([0-9a-fA-F]{32,64})["']/g
  for (const m of matches(hashVarRe)) {
    const name = m[1]
    const use = new RegExp(`(?:==|===|!=|!==)\\s*${name}\\b|\\.includes\\(\\s*${name}\\b`, "i")
    if (use.test(source)) {
      push({
        ruleId: "auth.hash-variable",
        level: "block",
        category: "backdoor",
        line: lineOf(source, m.index),
        summary: "哈希变量参与授权/白名单比较",
        operation: "隐藏身份获取主人权限",
        evidence: { mode: "decoded", text: `哈希：${m[2]}`, method: "变量保存的哈希字面量", hash: m[2], original: lineText(source, m.index) },
      })
    }
  }

  // 7. 固定身份数组 / includes 白名单
  const namedArrays = matches(/\b(?:masterQQ|whiteQQ|blackQQ|adminQQ|whiteList|blackList|whitelist|blacklist)\s*=\s*\[[^\]]*\d{5,}[^\]]*\]/gi)
  const numericArrays = matches(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[[^\]]*\d{5,}[^\]]*\]/gi)
  const includes = matches(/\.includes\(\s*(?:String\(\s*)?(?:[A-Za-z_$][\w$]*\.)*(?:user_id|userId|self_id|group_id|channel_id)\s*\)/gi)
  const namedMaster = namedArrays.some((m) => /\bmasterQQ\b|\badminQQ\b|\bmaster\b/i.test(m[0]))
  const numericUsed = numericArrays.find((m) => new RegExp(`\\b${m[1]}\\s*\\.includes\\(`, "i").test(source))
  // 只有“数字数组 + includes(user_id)”才算硬编码用户白名单；cfg.masterQQ.includes 等配置读取不算
  const numericUserArrays = numericArrays.filter((m) =>
    new RegExp(`\\b${m[1]}\\s*\\.includes\\(\\s*(?:String\\s*\\(\\s*)?(?:[A-Za-z_$][\\w$]*\\.)*(?:user_id|userId|self_id)`, "i").test(source),
  )
  const namedUserLevel = namedArrays.some((m) => /\b(?:whiteQQ|blackQQ)\b/i.test(m[0]))
  const usedNumeric =
    includes.length > 0 &&
    masterContext(contextOf(source, includes[0].index, 300)) &&
    numericUserArrays.length > 0
  if (namedArrays.length || numericArrays.length || includes.length) {
    // 只有明确的主人/隐藏授权语境才 block；普通用户白名单提示复核，群组白名单只记录。
    const arrayMaster =
      namedArrays.length > 0 && masterContext(contextOf(source, namedArrays[0].index, 300))
    const level =
      namedMaster || arrayMaster || usedNumeric
        ? "block"
        : namedUserLevel || numericUserArrays.length > 0
          ? "notify"
          : "silent"
    const at =
      namedArrays[0]?.index ??
      numericUserArrays[0]?.index ??
      numericUsed?.index ??
      includes[0]?.index ??
      0
    push({
      ruleId: "auth.fixed-id-list",
      level,
      category: "auth",
      line: lineOf(source, at),
      summary: "固定 QQ/ID 数组或 includes 白名单",
      operation:
        level === "block"
          ? "固定身份绕过权限/过滤"
          : level === "notify"
            ? "固定用户/权限白名单，需人工确认"
            : "固定身份列表",
      evidence: { mode: "plain", text: lineText(source, at) },
    })
  }

  // 7b. Set 集合形式的固定 ID 白名单
  const setLiteral = matches(/\bnew\s+Set\s*\(\s*\[[^\]]*\d{5,}[^\]]*\]\s*\)/gi)
  const hasUser = matches(/\.has\s*\(\s*(?:String\s*\(\s*)?(?:[A-Za-z_$][\w$]*\.)*(?:user_id|userId|self_id)\s*\)/gi)
  if (setLiteral.length && hasUser.length) {
    const master = masterContext(contextOf(source, setLiteral[0].index, 400))
    push({
      ruleId: "auth.fixed-id-list",
      level: master ? "block" : "notify",
      category: "auth",
      line: lineOf(source, setLiteral[0].index),
      summary: "Set 集合形式的固定 QQ/ID 白名单",
      operation: master ? "固定身份绕过权限/过滤" : "固定用户身份白名单，需人工确认",
      evidence: { mode: "plain", text: lineText(source, setLiteral[0].index) },
    })
  }

  // 8. 解码后的授权比较
  const decodeAt = source.search(/atob\(|Buffer\.from\(\s*["'][^"']+["']\s*,\s*["']base64["']\)|String\.fromCharCode\(/i)
  if (decodeAt >= 0 && permissionContext(contextOf(source, decodeAt, 500))) {
    const at = decodeAt
    const evidence = decodeEvidence(contextOf(source, at, 500))
    push({
      ruleId: "auth.decoded-authorization",
      level: "block",
      category: "backdoor",
      line: lineOf(source, at),
      summary: "解码内容参与授权/权限判断",
      operation: "隐藏身份获取主人权限",
      evidence,
    })
  }

  // 9. 动态代码执行
  for (const m of matches(/\b(eval|Function|vm\.(?:runInContext|runInNewContext|runInThisContext|compileFunction|Script))\s*\(/g)) {
    const after = source.slice(m.index + m[0].length)
    const close = after.indexOf(")")
    const arg = (close >= 0 ? after.slice(0, close) : after.slice(0, 300)).trim()
    const literal = /^(["'`])[\s\S]*\1$/.test(arg)
    const isVm = /^vm\./i.test(m[1])
    // vm/SDK/压缩包中的动态执行：参数含明确用户输入/解码数据时才提示，
    // 避免正常 SDK 噪音；普通源码仍按用户输入判定
    const vendor = isVendorBundle(ctx.rel)
    const strongRiskyArg = /e\.msg|user_id|atob|Buffer\.from/i.test(arg)
    const weakRiskyArg = /message|msg\b|process\.env/i.test(arg)
    const level = strongRiskyArg || (!vendor && !isVm && weakRiskyArg) ? "notify" : "silent"
    push({
      ruleId: "exec.dynamic-code",
      level,
      category: "execution",
      line: lineOf(source, m.index),
      summary: vendor ? "vendor/压缩包中的动态执行" : isVm ? "vm 沙箱执行" : "动态 eval/Function 执行",
      operation: "执行动态生成/外部输入/SDK 代码，需人工确认",
      evidence: { mode: "raw", original: lineText(source, m.index) },
    })
  }

  // 10. 远程/非字面量模块加载
  for (const m of matches(/\b(?:import|require)\s*\(\s*([^)]*)\)/gi)) {
    const arg = String(m[1] || "").trim()
    if (/^(?:["'`][^"'`]+["'`])$/.test(arg) && !/https?:|data:|blob:/i.test(arg)) continue
    const remote = /https?:|data:|blob:/i.test(arg)
    push({
      ruleId: "exec.remote-import",
      level: remote ? "block" : "silent",
      category: "execution",
      line: lineOf(source, m.index),
      summary: remote ? "远程/内联模块加载" : "非字面量模块加载",
      operation: remote ? "加载不可审计的远程代码" : "加载运行时计算的本地路径，需人工确认",
      evidence: { mode: "raw", original: lineText(source, m.index) },
    })
  }
  for (const m of matches(/\bimport\s+[^;\n]+\s+from\s+["'](?:https?:|data:|blob:)[^"']*["']/gi)) {
    push({
      ruleId: "exec.remote-static-import",
      level: "block",
      category: "execution",
      line: lineOf(source, m.index),
      summary: "静态导入远程/内联模块",
      operation: "加载不可审计代码",
      evidence: { mode: "raw", original: lineText(source, m.index) },
    })
  }

  // 11. 下载后执行 / 远程管道
  const hasNetwork = /\b(?:fetch|axios|got|https?\.(?:get|request))\s*\(/i.test(source)
  const hasWrite = /\b(?:writeFile|createWriteStream|appendFile)(?:Sync)?\s*\(/i.test(source)
  const hasCodeSink = /\b(?:eval|Function)\s*\(|\bimport\s*\(/.test(source)
  const codeTokens = (text) =>
    new Set(
      [...String(text).matchAll(/[\w./\\-]+\.(?:mjs|cjs|js|sh|py)\b/gi)].map((m) =>
        m[0].split(/[/\\]/).pop().toLowerCase(),
      ),
    )
  const writeText = [...source.matchAll(/\b(?:writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync)\s*\(\s*([^\n)]*)/g)]
    .map((m) => m[1])
    .join(" ")
  const importText = [...source.matchAll(/\bimport\s*\(\s*([^\n)]*)/g)].map((m) => m[1]).join(" ")
  const writeTokens = codeTokens(writeText)
  const sharedCodePath = [...codeTokens(importText)].some((t) => writeTokens.has(t))
  if (hasNetwork && hasWrite && hasCodeSink && sharedCodePath) {
    push({
      ruleId: "exec.download-execute",
      level: "block",
      category: "execution",
      line: 0,
      summary: "下载内容写入同一代码文件后交给执行入口",
      operation: "远程代码执行",
      evidence: { mode: "raw", original: "检测到网络下载 + 写入代码文件 + import/eval 同一路径" },
    })
  }
  for (const m of matches(/\b(?:curl|wget)\b[^\n|;]*\|\s*(?:ba|z|k)?sh\b|(?:base64|xxd)[^\n|;]*\|\s*(?:ba)?sh\b/gi)) {
    push({
      ruleId: "exec.remote-shell",
      level: "block",
      category: "execution",
      line: lineOf(source, m.index),
      summary: "远程脚本管道执行",
      operation: "下载并执行任意 shell 脚本",
      evidence: { mode: "raw", original: lineText(source, m.index) },
    })
  }

  // 12. 命令注入 / 子进程
  const childProcContext = /(?:node:)?child_process|Bot\.exec|util\.exec/.test(source)
  if (childProcContext) {
    for (const m of matches(/(?<![.\w$])(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(([^)]*)\)/g)) {
      const arg = m[2] || ""
      const risky = /e\.msg|this\.e\.msg|message|msg\b|\$\{\s*(?:this\.)?e\./i.test(arg)
      const dangerous =
        /\brm\s+-[a-z]*[rf][a-z]*\s+[^|;&]*(?:data|config|lib|renderers|plugins\/adapter|package\.json)/i.test(arg) ||
        /\b(?:curl|wget)\b[^|;]*\|\s*(?:ba|z|k)?sh\b/i.test(arg)
      const level = dangerous ? "block" : risky ? "notify" : "silent"
      push({
        ruleId: dangerous ? "exec.destructive-command" : "exec.child-process",
        level,
        category: "execution",
        line: lineOf(source, m.index),
        summary: dangerous ? "子进程执行破坏性命令" : risky ? "子进程调用含用户输入/拼接/shell" : "插件执行普通系统命令",
        operation: dangerous ? "删除核心目录或执行远程脚本" : risky ? "命令注入/任意命令执行，需人工确认" : "普通命令执行",
        evidence: { mode: "raw", original: lineText(source, m.index) },
      })
    }
  }
  for (const m of matches(/\bfork\s*\(([^)]*)\)/gi)) {
    const arg = m[1] || ""
    const risky = /e\.msg|user_id|message|https?:|data:|blob:/i.test(arg)
    push({
      ruleId: "exec.fork",
      level: risky ? "notify" : "silent",
      category: "execution",
      line: lineOf(source, m.index),
      summary: risky ? "fork 参数来自用户/远程" : "使用 child_process.fork",
      operation: risky ? "启动子进程执行不可信代码" : "启动子进程执行固定模块",
      evidence: { mode: "raw", original: lineText(source, m.index) },
    })
  }

  // 13. Git 危险参数
  for (const m of matches(/\bgit\b[^\n;&|]{0,200}(?:clone|checkout|pull|fetch|submodule)[^\n;&|]{0,200}/gi)) {
    const text = m[0]
    const risky = /(?:^|\s)-c(?=\s|=|$)|ext::|--(?:upload-pack|receive-pack|exec)\b/.test(text)
    push({
      ruleId: "exec.git-argument",
      level: risky ? "notify" : "silent",
      category: "execution",
      line: lineOf(source, m.index),
      summary: risky ? "git 参数含变量/危险传输选项" : "插件执行 git 更新",
      operation: risky ? "通过 git 参数执行任意命令" : "自动更新代码，需确认来源",
      evidence: { mode: "raw", original: lineText(source, m.index) },
    })
  }

  // 14. 路径穿越 / 用户输入进入 fs
  for (const m of matches(/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|createWriteStream|copyFile|copyFileSync|rename|renameSync)\s*\(([^)]*)\)/gi)) {
    const arg = m[1] || ""
    if (/e\.msg|this\.e\.msg/.test(arg)) {
      push({
        ruleId: "fs.user-path",
        level: "notify",
        category: "tamper",
        line: lineOf(source, m.index),
        summary: "文件操作路径包含用户输入或路径穿越",
        operation: "读写/删除插件目录之外的任意文件",
        evidence: { mode: "plain", text: lineText(source, m.index) },
      })
    }
  }

  // 15. 写/删核心路径（必须是路径字面量开头，避免把插件自己的 xx/config/config 当成本体配置）
  for (const m of matches(/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|copyFile|copyFileSync|rename|renameSync|truncate|truncateSync)\s*\(\s*["'`](?:\.\/)?(?:lib|renderers|config\/config|data\/security|data\/panel|\.git|package\.json|plugins\/adapter)(?:[\/\\]|["'`])/gi)) {
    push({
      ruleId: "tamper.core-path",
      level: "block",
      category: "tamper",
      line: lineOf(source, m.index),
      summary: "文件操作指向本体核心路径",
      operation: "篡改/删除本体核心文件",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }

  // 16. 关闭防护
  for (const m of matches(/\b(?:dataGuard|cmdGuard|pluginScan)\s*:\s*false\b/gi)) {
    push({
      ruleId: "tamper.disable-guard",
      level: "block",
      category: "tamper",
      line: lineOf(source, m.index),
      summary: "代码尝试关闭安全防护开关",
      operation: "关闭数据/命令/插件扫描防护",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }

  // 17. 原生模块 / 进程内部接口
  for (const m of matches(/\b(?:require|import)\s*\(\s*["'][^"']+\.node["']|process\.(?:dlopen|binding)\s*\(/gi)) {
    push({
      ruleId: "binary.native-load",
      level: "block",
      category: "binary",
      line: lineOf(source, m.index),
      summary: "加载原生模块或进程内部接口",
      operation: "执行不可审计的原生代码",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }

  // 18. 敏感读取 + 外发
  const sensitiveRead = /readFile(?:Sync)?\s*\([^)]*(?:config\/config|bot\.yaml|data\/panel|\.env|secret)/i.test(source)
  const hardSensitive = /readFile(?:Sync)?\s*\([^)]*(?:bot\.yaml|data\/panel|\.env|secret)/i.test(source)
  const networkSink = /\b(?:fetch|axios|got|https?\.(?:get|request)|net\.connect|WebSocket)\s*\(/i.test(source)
  const exfil = hardSensitive && networkSink
  if (sensitiveRead) {
    push({
      ruleId: exfil ? "exfil.sensitive-read" : "secret.sensitive-read",
      level: exfil ? "block" : "silent",
      category: exfil ? "exfiltration" : "secret",
      line: lineOf(source, source.search(/readFile(?:Sync)?/i)),
      summary: exfil ? "读取主人配置/凭据并存在网络外发入口" : "读取配置文件",
      operation: exfil ? "可能外传主人配置/凭据" : "读取配置，需人工确认",
      evidence: { mode: "raw", original: lineText(source, source.search(/readFile(?:Sync)?/i)) },
    })
  }

  // 19. 硬编码凭据
  for (const m of matches(/\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{20,}|(?:SecretId|SecretKey|AccessKey)\s*[:=]\s*["'][^"']{6,}["'])/gi)) {
    // 占位符要看“凭据本身”和它前面的赋值/字段名；不能因为同行末尾有 example 注释就整行跳过
    const lineStart = source.lastIndexOf("\n", m.index) + 1
    const prefix = source.slice(lineStart, m.index).replace(/\/\*[\s\S]*?\*\//g, "")
    if (
      /placeholder|请输入|示例|example|sample/i.test(m[0]) ||
      /placeholder|请输入|示例|example|sample/i.test(prefix)
    ) continue
    push({
      ruleId: "secret.hardcoded",
      level: "notify",
      category: "secret",
      line: lineOf(source, m.index),
      summary: networkSink ? "硬编码凭据且存在网络请求" : "硬编码凭据",
      operation: "凭据暴露，需轮换/移除；若同时读取敏感配置并外发会另行拦截",
      evidence: { mode: "raw", original: lineText(source, m.index) },
    })
  }

  // 20. 弱默认口令 / 对外服务
  for (const m of matches(/(?:password|passwd|pwd)\s*[:=]\s*["'](?:admin123|123456|password|passwd)["']/gi)) {
    const exposed = /listen\s*\([^)]*(?:0\.0\.0\.0|::)|publicAccess\s*:\s*true/i.test(source)
    push({
      ruleId: "secret.weak-default",
      level: exposed ? "block" : "notify",
      category: "secret",
      line: lineOf(source, m.index),
      summary: exposed ? "弱默认口令 + 对外服务" : "弱默认口令",
      operation: exposed ? "对外服务使用弱口令" : "弱口令风险，需人工确认",
      evidence: { mode: "raw", original: lineText(source, m.index) },
    })
  }

  // 21. 混淆
  const obfuscated =
    (source.match(/\b_0x[0-9a-f]{3,}\b/gi) || []).length >= 3 ||
    /jsjiami\.com|eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)/i.test(source) ||
    (source.match(/\\x[0-9a-fA-F]{2}/g) || []).length > 20
  if (obfuscated) {
    const execNearby = /\b(?:eval|Function|vm\.)|import\s*\(|fetch\s*\(|axios\s*\(/i.test(source)
    push({
      ruleId: "obfuscation.detected",
      level: isVendorBundle(ctx.rel) ? "silent" : "notify",
      category: "obfuscation",
      line: lineOf(source, source.search(/_0x|jsjiami|\\x[0-9a-fA-F]{2}/i)),
      summary: execNearby ? "混淆代码（含执行/网络入口）" : "检测到混淆/压缩代码",
      operation: "需人工确认来源；常见于第三方 SDK/min.js，不自动拦截",
      evidence: { mode: "raw", original: lineText(source, source.search(/_0x|jsjiami|\\x[0-9a-fA-F]{2}/i)) },
    })
  }

  // 22. 自动更新
  for (const m of matches(/\bgit\s+(?:pull|clone)\b/gi)) {
    push({
      ruleId: "supply.auto-update",
      level: "silent",
      category: "supply",
      line: lineOf(source, m.index),
      summary: "插件代码包含自动 git 更新",
      operation: "运行时拉取外部代码",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }

  // 23. 修改主人列表（运行时已用配置快照，修改不会提权，但需提示复核）
  const masterMutation = [
    /\b(?:cfg|config)\s*\.\s*masterQQ\s*(?:\.\s*(?:push|splice|unshift|pop|shift|sort|reverse|fill|copyWithin)\s*\(|(?<![=!<>])=(?!=))/gi,
    /\b(?:cfg|config)\s*\.\s*getConfig\s*\(\s*["']other["']\s*\)\s*\.\s*masterQQ\s*(?:\.\s*(?:push|splice|unshift|pop|shift|sort|reverse|fill|copyWithin)\s*\(|(?<![=!<>])=(?!=))/gi,
    /\bObject\s*\.\s*defineProperty\s*\(\s*(?:cfg|config)\s*,\s*["']masterQQ["']/gi,
  ]
  for (const re of masterMutation) {
    for (const m of matches(re)) {
      push({
        ruleId: "tamper.master-list",
        level: "notify",
        category: "tamper",
        line: lineOf(source, m.index),
        summary: "代码修改主人列表",
        operation: "运行时使用配置快照，修改不会提权；需人工确认来源",
        evidence: { mode: "plain", text: lineText(source, m.index) },
      })
    }
  }

  // 24. 改写内置原型/审计原语（热安装时可致盲静态审计或权限判定）
  const AUDIT_PRIMITIVES = new Set([
    "includes", "indexOf", "lastIndexOf", "test", "exec", "match", "matchAll",
    "some", "every", "filter", "find", "has", "get", "set", "keys", "values",
    "entries", "defineProperty", "getOwnPropertyDescriptor", "freeze", "seal",
    "preventExtensions", "isArray", "parse", "stringify",
  ])
  // 兼容性 polyfill 常写成 if/&&/|| 保护；条件式补丁只提示，无条件改写才拦截
  const patchGuarded = (at) => {
    const before = source.slice(Math.max(0, at - 160), at)
    return (
      /(?:\|\||&&)\s*\(?\s*$/.test(before) ||
      /\bif\s*\([^;]{0,120}\)\s*\{[^{}]{0,80}$/.test(before) ||
      /\bif\s*\([^;]{0,120}\)\s*$/.test(before)
    )
  }
  const protoAssign = /\b(?:Array|String|Object|Function|RegExp)\s*\.\s*prototype\s*\.\s*([A-Za-z_$][\w$]*)\s*(?<![=!<>])=(?!=)/gi
  for (const m of matches(protoAssign)) {
    if (!AUDIT_PRIMITIVES.has(m[1])) continue
    const guarded = patchGuarded(m.index)
    push({
      ruleId: "tamper.builtin-patch",
      level: guarded ? "notify" : "block",
      category: "tamper",
      line: lineOf(source, m.index),
      summary: guarded ? "条件式改写安全判定依赖的内置原型方法" : "改写安全判定依赖的内置原型方法",
      operation: guarded ? "常见于兼容性补丁，需人工确认" : "可能致盲审计/绕过权限判断",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }
  const staticAssign = /\b(?:Object|JSON|Array|String|RegExp|Function|Reflect)\s*\.\s*(defineProperty|getOwnPropertyDescriptor|freeze|seal|preventExtensions|isArray|keys|getPrototypeOf|setPrototypeOf|parse|stringify|apply|call|bind)\s*(?<![=!<>])=(?!=)/gi
  for (const m of matches(staticAssign)) {
    const guarded = patchGuarded(m.index)
    push({
      ruleId: "tamper.builtin-patch",
      level: guarded ? "notify" : "block",
      category: "tamper",
      line: lineOf(source, m.index),
      summary: guarded ? "条件式改写内置对象/审计原语" : "改写内置对象/审计原语",
      operation: guarded ? "常见于兼容性补丁，需人工确认" : "可能致盲审计/绕过权限判断",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }
  const protoDefine = /\bObject\s*\.\s*defineProperty\s*\(\s*(?:Array|String|Object|Function|RegExp)\s*\.\s*prototype\s*,\s*["']([A-Za-z_$][\w$]*)["']/gi
  for (const m of matches(protoDefine)) {
    if (!AUDIT_PRIMITIVES.has(m[1])) continue
    const guarded = patchGuarded(m.index)
    push({
      ruleId: "tamper.builtin-patch",
      level: guarded ? "notify" : "block",
      category: "tamper",
      line: lineOf(source, m.index),
      summary: guarded ? "条件式改写安全判定依赖的内置原型方法" : "改写安全判定依赖的内置原型方法",
      operation: guarded ? "常见于兼容性补丁，需人工确认" : "可能致盲审计/绕过权限判断",
      evidence: { mode: "plain", text: lineText(source, m.index) },
    })
  }

  // 测试文件也扫描：测试夹具会放大执行类噪音，但确定性后门/远程代码必须保留拦截级
  if (isTestFile(ctx.rel)) {
    for (const f of out) {
      if (f.level === "block" && !isNeverAllowRule(f.ruleId)) f.level = "notify"
      if (f.level === "notify" && TEST_SILENT_RULES.has(f.ruleId)) f.level = "silent"
    }
  }

  return out
}

function auditPackage(ctx, pkg) {
  const out = []
  const scripts = pkg?.scripts || {}
  for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) {
      out.push(makeFinding(ctx, {
        ruleId: "supply.install-script",
        level: "notify",
        category: "supply",
        line: 0,
        summary: `package.json 包含 ${name} 安装脚本`,
        operation: "安装依赖时执行任意代码",
        evidence: { mode: "plain", text: `${name}: ${scripts[name]}` },
      }))
    }
  }
  return out
}

/**
 * 审计一个插件目录
 * @param {string} pluginDir 插件目录
 * @param {string} name 插件名
 * @returns {{plugin:string, findings:object[], blocked:boolean}}
 */
export function auditPlugin(pluginDir, name = path.basename(pluginDir)) {
  const root = path.resolve(pluginDir)
  const findings = []
  let files = []
  let baseDir = root
  try {
    if (fs.statSync(root).isFile()) {
      files = [root]
      baseDir = path.dirname(root)
    } else {
      files = walk(root)
    }
  } catch {
    return { plugin: name, findings, blocked: false }
  }
  const pkgFile = path.join(baseDir, "package.json")
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"))
  } catch {}
  if (pkg) findings.push(...auditPackage({ name, root: baseDir, rel: "package.json", fileHash: sha256(JSON.stringify(pkg)), source: "" }, pkg))

  for (const full of files) {
    const rel = path.relative(baseDir, full).replace(/\\/g, "/")
    const base = path.basename(full)
    const ext = path.extname(base).toLowerCase()
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }

    if (/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(base)) {
      findings.push(makeFinding({ name, root, rel, fileHash: fileHashOf(full) }, {
        ruleId: "obfuscation.hidden-filename",
        level: "block",
        category: "obfuscation",
        line: 0,
        summary: "文件名包含 RTL/零宽隐藏字符",
        operation: "伪装文件/隐藏授权文件",
        evidence: { mode: "raw", original: rel },
      }))
    }
    if (rel.startsWith(".github/ISSUE_TEMPLATE/") && !/\.(?:ya?ml|md|txt|rst)$/i.test(base) && stat.size > 0) {
      findings.push(makeFinding({ name, root, rel, fileHash: fileHashOf(full) }, {
        ruleId: "auth.hidden-file",
        level: "block",
        category: "backdoor",
        line: 0,
        summary: "ISSUE_TEMPLATE 下存在非 YAML 隐藏文件",
        operation: "隐藏授权文件载体",
        evidence: { mode: "raw", original: rel },
      }))
    }
    if (BINARY_EXT.has(ext)) {
      findings.push(makeFinding({ name, root, rel, fileHash: fileHashOf(full) }, {
        ruleId: "binary.file",
        level: "notify",
        category: "binary",
        line: 0,
        summary: `插件内置二进制文件 ${ext}`,
        operation: "执行不可审计的二进制/原生代码",
        evidence: { mode: "plain", text: `${rel} (${stat.size} bytes)` },
      }))
      continue
    }
    if (SCRIPT_EXT.has(ext)) {
      let hit = ""
      let unread = false
      try {
        if (stat.size > MAX_CODE_SIZE) unread = true
        else hit = inspectScriptText(stripScriptComments(fs.readFileSync(full, "utf8"), ext)) || ""
      } catch {
        unread = true
      }
      findings.push(makeFinding({ name, root, rel, fileHash: fileHashOf(full) }, {
        ruleId: hit ? "binary.script-danger" : "binary.script",
        level: hit ? "block" : "notify",
        category: "binary",
        line: 0,
        summary: hit ? `插件内置系统脚本包含危险命令：${hit}` : `插件内置系统脚本 ${ext}`,
        operation: hit
          ? "静态审计命中删除核心路径/远程执行等危险命令"
          : unread
            ? "脚本未完整审计，需人工确认"
            : "可能执行系统命令，需人工确认",
        evidence: { mode: "plain", text: `${rel} (${stat.size} bytes)${hit ? `：${hit}` : unread ? "：未完整审计" : ""}` },
      }))
    }
    if (!CODE_EXT.has(ext)) continue
    if (stat.size > MAX_CODE_SIZE) {
      findings.push(makeFinding({ name, root, rel, fileHash: fileHashOf(full) }, {
        ruleId: "audit.large-file",
        level: "notify",
        category: "audit",
        line: 0,
        summary: "代码文件过大，未完整静态审计",
        operation: "已备份并提示人工复核",
        evidence: { mode: "plain", text: `${rel} (${stat.size} bytes)` },
      }))
      continue
    }
    let source = ""
    try {
      source = fs.readFileSync(full, "utf8")
    } catch {
      continue
    }
    findings.push(...auditSource({ name, root: baseDir, rel, source, fileHash: sha256(source) }))
  }

  return { plugin: name, findings, blocked: findings.some((f) => f.level === "block") }
}

export { auditSource }
