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

let loaded = false
let lastHash = "GENESIS"
const seen = new Set()
const notified = new Set()

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex")
}

function clip(value) {
  const text = String(value ?? "")
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

function normalizePlugin(value) {
  const m = String(value || "").match(/plugins[\\/]([^\\/]+)/i)
  return m ? m[1] : String(value || "未知来源")
}

function ensureLoaded() {
  if (loaded) return
  loaded = true
  try {
    fs.mkdirSync(DIR, { recursive: true })
    const raw = fs.readFileSync(FILE, "utf8").trimEnd()
    if (!raw) return
    const lines = raw.split("\n").slice(-MAX_LOAD)
    for (const line of lines) {
      try {
        const rec = JSON.parse(line)
        if (rec?.id) seen.add(rec.id)
        if (rec?.hash) lastHash = rec.hash
      } catch {}
    }
  } catch {}
}

/** 以磁盘最后一条记录为准，避免多实例/外部截断导致链头陈旧 */
function readLastHash() {
  try {
    const raw = fs.readFileSync(FILE, "utf8").trimEnd()
    if (!raw) return "GENESIS"
    const rec = JSON.parse(raw.split("\n").pop())
    return rec?.hash || "GENESIS"
  } catch {
    return "GENESIS"
  }
}

/** 稳定 findingId：同一插件、规则、文件、行、证据、文件哈希只算同一条 */
export function makeFindingId(input = {}) {
  return sha256(
    [
      input.plugin || "",
      input.ruleId || "",
      input.file || "",
      input.line || "",
      input.summary || "",
      input.evidence?.text || input.evidence?.original || "",
      input.fileHash || "",
    ].join("\u0000"),
  ).slice(0, 24)
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
  const action = rec.level === "block" ? "已拦截" : rec.level === "notify" ? "已记录并通报" : "仅记录"
  return [
    `【安全${rec.level === "block" ? "拦截" : rec.level === "notify" ? "通报" : "记录"}】插件：${rec.plugin}`,
    `规则：${rec.ruleId}（${rec.category || "其他"}）`,
    `位置：${rec.file || "-"}${rec.line ? `:${rec.line}` : ""}`,
    `方式：${rec.evidence?.method || "静态特征"}`,
    `证据：${formatEvidence(rec.evidence)}`,
    `操作：${clip(rec.operation || rec.summary)}`,
    `处置：${action}`,
    `记录：${rec.id}`,
  ].join("\n")
}

/**
 * 记录一条 finding，并按 findingId 通知。
 * repeat=true 用于运行时事件：每次动作都独立记录、独立通知，不做同类合并。
 */
export function handleFinding(input = {}, { repeat = false, group = false, notify = true } = {}) {
  ensureLoaded()
  const baseId = input.id || makeFindingId(input)
  const id = repeat ? `${baseId}:${Date.now()}:${process.hrtime.bigint()}` : baseId
  if (!repeat && seen.has(id)) return null

  lastHash = readLastHash()
  const body = {
    t: new Date().toISOString(),
    id,
    plugin: normalizePlugin(input.plugin),
    ruleId: String(input.ruleId || "unknown"),
    level: input.level === "block" || input.level === "silent" ? input.level : "notify",
    category: String(input.category || "其他"),
    file: String(input.file || ""),
    line: Number(input.line) || 0,
    fileHash: String(input.fileHash || ""),
    summary: String(input.summary || ""),
    operation: String(input.operation || ""),
    evidence: {
      mode: ["plain", "decoded", "raw"].includes(input.evidence?.mode) ? input.evidence.mode : "raw",
      text: String(input.evidence?.text || ""),
      original: String(input.evidence?.original || ""),
      method: String(input.evidence?.method || ""),
      hash: String(input.evidence?.hash || ""),
    },
    prev: lastHash,
  }
  const rec = { ...body, hash: sha256(lastHash + JSON.stringify(body)) }
  try {
    appendFinding(FILE, `${JSON.stringify(rec)}\n`, "utf8")
    lastHash = rec.hash
  } catch (err) {
    global.logger?.error?.("[安全记录] 写入失败", err)
  }
  seen.add(id)
  if (!notified.has(id)) {
    notified.add(id)
    if (notify) {
      notifyMaster(formatFinding(rec))
      if (group && rec.level === "block") broadcast(formatFinding(rec))
    }
  }
  return rec
}

export function verifyFindingChain() {
  ensureLoaded()
  try {
    const lines = fs.readFileSync(FILE, "utf8").trim().split("\n").filter(Boolean)
    let prev = "GENESIS"
    for (const line of lines) {
      const rec = JSON.parse(line)
      const { hash, ...body } = rec
      if (body.prev !== prev) return { ok: false, at: rec.id, reason: "prev 不匹配" }
      const expect = sha256(prev + JSON.stringify(body))
      if (hash !== expect) return { ok: false, at: rec.id, reason: "hash 不匹配" }
      prev = hash
    }
    return { ok: true, count: lines.length, head: prev }
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) }
  }
}

export { FILE as findingFile }
