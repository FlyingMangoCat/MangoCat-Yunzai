import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { notifyMaster, broadcast } from "../config/guardCore.js"

/**
 * 安全发现逐条记录
 *
 * 每条命中都有独立 findingId，写入追加式 JSONL 并串成哈希链；
 * 不保存"某插件某规则已处理"的聚合状态，避免一条记录掩盖同类问题。
 * 通知只按 findingId 去重：不同文件/行/证据永远是不同记录。
 */

const DIR = path.resolve("data/security")
const FILE = path.join(DIR, "findings.jsonl")
const MAX_LOAD = 10000
const MAX_TEXT = 800
// 在 fsGuard 安装前快照原始写入函数，避免审计记录被自己的写保护拦截
const appendFinding = fs.appendFileSync.bind(fs)
// 启动时快照：插件改写 crypto/JSON/Set/Array/String 不能伪造或吞掉记录
const nativeString = String
const nativeCreateHash = crypto.createHash.bind(crypto)
const nativeJsonParse = JSON.parse
const nativeJsonStringify = JSON.stringify
const nativeReadFileSync = fs.readFileSync.bind(fs)
const nativeMkdirSync = fs.mkdirSync.bind(fs)
const nativeSetHas = Function.call.bind(Set.prototype.has)
const nativeSetAdd = Function.call.bind(Set.prototype.add)
const nativeArrayIncludes = Function.call.bind(Array.prototype.includes)
const nativeStringStartsWith = Function.call.bind(String.prototype.startsWith)
const nativeRegExpExec = Function.call.bind(RegExp.prototype.exec)
const nativeStringSplit = Function.call.bind(String.prototype.split)
const nativeStringTrim = Function.call.bind(String.prototype.trim)
const nativeStringTrimEnd = Function.call.bind(String.prototype.trimEnd)
const nativeStringSlice = Function.call.bind(String.prototype.slice)
const nativeDateNow = Date.now
const NativeDate = Date
const nativeToISOString = Function.call.bind(Date.prototype.toISOString)

let loaded = false
let lastHash = "GENESIS"
const seen = new Set()
const notified = new Set()

function sha256(text) {
  return nativeCreateHash("sha256").update(nativeString(text)).digest("hex")
}

function clip(value) {
  const text = nativeString(value ?? "")
  return text.length > MAX_TEXT ? `${nativeStringSlice(text, 0, MAX_TEXT)}…` : text
}

function normalizePlugin(value) {
  const text = nativeString(value || "")
  if (!nativeStringStartsWith(text, "本体(") && !nativeStringStartsWith(text, "未知来源")) {
    const m = nativeRegExpExec(/(?:^|[/\\])plugins[\\/]([^\\/]+)/i, text)
    if (m) return m[1]
  }
  return text || "未知来源"
}

function ensureLoaded() {
  if (loaded) return
  loaded = true
  try {
    nativeMkdirSync(DIR, { recursive: true })
    const raw = nativeStringTrimEnd(nativeReadFileSync(FILE, "utf8"))
    if (!raw) return
    const parts = nativeStringSplit(raw, "\n")
    const start = parts.length > MAX_LOAD ? parts.length - MAX_LOAD : 0
    for (let i = start; i < parts.length; i++) {
      try {
        const rec = nativeJsonParse(parts[i])
        if (rec?.id) nativeSetAdd(seen, rec.id)
        if (rec?.hash) lastHash = rec.hash
      } catch {}
    }
  } catch {}
}

/** 以磁盘最后一条记录为准，避免多实例/外部截断导致链头陈旧 */
function readLastHash() {
  try {
    const raw = nativeStringTrimEnd(nativeReadFileSync(FILE, "utf8"))
    if (!raw) return "GENESIS"
    const parts = nativeStringSplit(raw, "\n")
    const rec = nativeJsonParse(parts[parts.length - 1])
    return rec?.hash || "GENESIS"
  } catch {
    return "GENESIS"
  }
}

/** 单条 finding 的定位键：不含处置动作，供误报放行精确匹配 */
export function makeFindingKey(input = {}) {
  const parts = [
    input.plugin || "",
    input.ruleId || "",
    input.file || "",
    input.line || "",
    input.summary || "",
    input.evidence?.text || input.evidence?.original || "",
    input.fileHash || "",
  ]
  let raw = ""
  for (let i = 0; i < parts.length; i++) raw += (i ? "\u0000" : "") + nativeString(parts[i])
  return nativeStringSlice(sha256(raw), 0, 24)
}

/** 稳定 findingId：定位键 + 处置动作；同一位置动作变化会生成新记录 */
export function makeFindingId(input = {}) {
  const key = makeFindingKey(input)
  return input.action ? nativeStringSlice(sha256(`${key}\u0000${input.action}`), 0, 24) : key
}

function formatEvidence(evidence = {}) {
  const mode = evidence.mode || "raw"
  if (mode === "plain") return `明文：${clip(evidence.text)}`
  if (mode === "decoded") {
    const parts = [`解析结果：${clip(evidence.text)}`]
    if (evidence.method) parts.push(`来源方式：${clip(evidence.method)}`)
    if (evidence.hash) parts.push(`哈希：${clip(evidence.hash)}`)
    if (evidence.original) parts.push(`原文：${clip(evidence.original)}`)
    return parts.join("\n")
  }
  return `原文（未解析）：${clip(evidence.original || evidence.text)}`
}

export function formatFinding(rec) {
  const action = rec.action || (rec.level === "block" ? "block" : rec.level === "notify" ? "notify" : "record")
  const actionText = action === "block" ? "已拦截" : action === "notify" ? "已记录并通报" : "仅记录"
  const title = action === "block" ? "拦截" : action === "notify" ? "通报" : "记录"
  return [
    `【安全${title}】插件：${rec.plugin}`,
    `规则：${rec.ruleId}（${rec.category || "其他"}）`,
    `位置：${rec.file || "-"}${rec.line ? `:${rec.line}` : ""}`,
    `方式：${rec.evidence?.method || "静态特征"}`,
    `证据：${formatEvidence(rec.evidence)}`,
    `操作：${clip(rec.operation || rec.summary)}`,
    `处置：${actionText}`,
    `记录：${rec.id}`,
    ...(rec.key && rec.key !== rec.id ? [`定位键：${rec.key}`] : []),
  ].join("\n")
}

/**
 * 记录一条 finding，并按 findingId 通知。
 * repeat=true 用于运行时事件：每次动作都独立记录、独立通知，不做同类合并。
 */
let recordInFlight = false

export function handleFinding(input = {}, opts = {}) {
  if (recordInFlight) return null
  recordInFlight = true
  try {
    return handleFindingInternal(input, opts)
  } finally {
    recordInFlight = false
  }
}

function handleFindingInternal(input = {}, { repeat = false, group = false, notify = true } = {}) {
  ensureLoaded()
  const key = input.key || makeFindingKey(input)
  const baseId = input.id || makeFindingId(input)
  const id = repeat ? `${baseId}:${nativeDateNow()}:${process.hrtime.bigint()}` : baseId
  if (!repeat && nativeSetHas(seen, id)) return null

  lastHash = readLastHash()
  const body = {
    t: nativeToISOString(new NativeDate()),
    id,
    key,
    plugin: normalizePlugin(input.plugin),
    ruleId: nativeString(input.ruleId || "unknown"),
    level: input.level === "block" || input.level === "silent" ? input.level : "notify",
    action: nativeArrayIncludes(["off", "record", "notify", "block"], input.action) ? input.action : "",
    category: nativeString(input.category || "其他"),
    file: nativeString(input.file || ""),
    line: Number(input.line) || 0,
    fileHash: nativeString(input.fileHash || ""),
    summary: nativeString(input.summary || ""),
    operation: nativeString(input.operation || ""),
    evidence: {
      mode: nativeArrayIncludes(["plain", "decoded", "raw"], input.evidence?.mode) ? input.evidence.mode : "raw",
      text: nativeString(input.evidence?.text || ""),
      original: nativeString(input.evidence?.original || ""),
      method: nativeString(input.evidence?.method || ""),
      hash: nativeString(input.evidence?.hash || ""),
    },
    prev: lastHash,
  }
  const rec = { ...body, hash: sha256(lastHash + nativeJsonStringify(body)) }
  try {
    appendFinding(FILE, `${nativeJsonStringify(rec)}\n`, "utf8")
    lastHash = rec.hash
  } catch (err) {
    global.logger?.error?.("[安全记录] 写入失败", err)
  }
  nativeSetAdd(seen, id)
  if (!nativeSetHas(notified, id)) {
    nativeSetAdd(notified, id)
    if (notify) {
      notifyMaster(formatFinding(rec))
      if (group && (rec.action === "block" || (!rec.action && rec.level === "block"))) {
        broadcast(formatFinding(rec))
      }
    }
  }
  return rec
}

export function verifyFindingChain() {
  ensureLoaded()
  try {
    const parts = nativeStringSplit(nativeStringTrim(nativeReadFileSync(FILE, "utf8")), "\n")
    const lines = []
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) lines[lines.length] = parts[i]
    }
    let prev = "GENESIS"
    for (let i = 0; i < lines.length; i++) {
      const rec = nativeJsonParse(lines[i])
      const { hash, ...body } = rec
      if (body.prev !== prev) return { ok: false, at: rec.id, reason: "prev 不匹配" }
      const expect = sha256(prev + nativeJsonStringify(body))
      if (hash !== expect) return { ok: false, at: rec.id, reason: "hash 不匹配" }
      prev = hash
    }
    return { ok: true, count: lines.length, head: prev }
  } catch (err) {
    return { ok: false, reason: nativeString(err?.message || err) }
  }
}

export { FILE as findingFile }
