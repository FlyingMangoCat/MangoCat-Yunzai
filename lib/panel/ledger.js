import fs from "node:fs"
import path from "node:path"
import fetch from "node-fetch"
import cfg from "../config/config.js"

/**
 * 插件收录台账
 *
 * 唯一数据来源是 one-button 仓库的 include.md（Markdown 表格），面板只做解析与缓存：
 * - 配置了 ledger.localPath 且文件存在时优先读本地，方便维护时实时看到改动；
 * - 否则按 ledger.cacheMinutes 缓存远端结果，缓存过期才重新拉取；
 * - 远端拉取失败时回退到上一次缓存并标记 stale，不阻断面板其它功能。
 */

const CACHE_FILE = path.resolve("data/panel/ledger.json")
let memory = null

function panelConf() {
  const def = cfg.getdefSet?.("panel")?.panel || {}
  const user = cfg.getConfig?.("panel")?.panel || {}
  return {
    ...def,
    ...user,
    ledger: { ...(def.ledger || {}), ...(user.ledger || {}) },
    install: { ...(def.install || {}), ...(user.install || {}) },
  }
}

export function installConf() {
  return panelConf().install || {}
}

/** 单元格里的 Markdown 链接：取第一个链接文本与全部链接地址 */
function parseCell(cell) {
  const raw = String(cell || "").trim()
  const links = []
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
  let m
  while ((m = re.exec(raw))) links.push({ text: m[1].trim(), url: m[2].trim() })
  let text = raw.replace(re, "$1").replace(/\*\*/g, "").trim()
  return { text, links }
}

function tierOf(text) {
  // 已失效条目保留在表内只改等级，不删行
  if (/已失效/.test(text) || text.includes("⚫")) return { tier: "retired", label: "已失效" }
  if (/官方/.test(text) || text.includes("🟢")) return { tier: "official", label: "官方" }
  if (/已收录/.test(text) || text.includes("🟡")) return { tier: "audited", label: "已收录" }
  return { tier: "unknown", label: "未审核" }
}

/** 合规层：台账「层」列 → L0–L3；未填时官方/已收录默认 L1，未审核/已失效 L0 */
function normalizeLayer(value, tier) {
  const s = String(value ?? "").trim().toUpperCase()
  if (/^L[0-3]$/.test(s)) return s
  if (/^[0-3]$/.test(s)) return `L${s}`
  return tier === "unknown" || tier === "retired" ? "L0" : "L1"
}

/** 仓库链接所属平台；raw.githubusercontent.com 归 GitHub，AtomGit 归 GitCode */
function platformOf(url) {
  const text = String(url || "").trim()
  if (!text) return ""
  if (/^https?:\/\/(?:www\.)?github\.com\//i.test(text) || /^https?:\/\/raw\.githubusercontent\.com\//i.test(text)) return "github"
  if (/^https?:\/\/(?:www\.)?gitee\.com\//i.test(text)) return "gitee"
  if (/^https?:\/\/(?:www\.)?gitcode\.com\//i.test(text) || /^https?:\/\/(?:www\.)?atomgit\.com\//i.test(text)) return "gitcode"
  if (/^https?:\/\/(?:www\.)?gitlab\.com\//i.test(text)) return "gitlab"
  if (/^https?:\/\/(?:ghproxy\.net|gh-proxy\.com)\//i.test(text)) return platformOf(text.replace(/^https?:\/\/[^/]+\//, ""))
  return ""
}

/** 仓库唯一键；同一仓库在台账里出现多次时用于集合仓折算 */
function repoKeyOf(url) {
  const text = String(url || "").trim()
  if (!text) return ""
  if (/^https?:\/\/(?:ghproxy\.net|gh-proxy\.com)\//i.test(text)) return repoKeyOf(text.replace(/^https?:\/\/[^/]+\//, ""))
  const platform = platformOf(text)
  if (!platform) return ""
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return ""
  }
  const seg = parsed.pathname.split("/").filter(Boolean)
  if (seg.length < 2) return ""
  return `${platform}:${seg[0]}/${seg[1].replace(/\.git$/, "")}`.toLowerCase()
}

/** Star 单元格：兼容旧的纯数字，也支持 `GitHub 1593 / Gitee 65` 分平台写法 */
function parseStarCell(raw) {
  const text = String(raw || "").trim()
  const stars = {}
  if (/^\d+$/.test(text)) return { stars, legacy: Number(text) }
  const re = /\b(github|gitee|gitcode|gitlab)\s*([0-9]+)/gi
  for (const m of text.matchAll(re)) stars[m[1].toLowerCase()] = Number(m[2])
  return { stars, legacy: null }
}

/** 解析 include.md 表格；列名按表头识别，缺列时按默认顺序兜底 */
export function parseLedger(text) {
  const lines = String(text || "").split(/\r?\n/)
  const rows = []
  let headers = null
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith("|")) continue
    const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((i) => i.trim())
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue
    if (!headers) {
      headers = cells
      continue
    }
    const cell = (name, fallbackIndex) => {
      const idx = headers.findIndex((h) => h.includes(name))
      return cells[idx >= 0 ? idx : fallbackIndex] ?? ""
    }
    const grade = cell("等级", 0)
    const tierInfo = tierOf(grade)
    const layerRaw = cell("层", 99) || cell("Layer", 99)
    const pluginCell = parseCell(cell("插件", 1))
    if (!pluginCell.text) continue
    const author = parseCell(cell("作者", 2))
    const desc = parseCell(cell("简介", 3))
    const download = parseCell(cell("下载", 4))
    const type = parseCell(cell("类型", 3)).text || cell("类型", 3)
    const checkDate = cell("检查", 5)
    const hash = cell("哈希", 6).replace(/`/g, "").trim()
    const note = parseCell(cell("备注", 7)).text || cell("备注", 7)
    const starRaw = cell("Star", 8).trim()
    const lastCommitRaw = cell("最后提交", 9).trim()
    const firstCommitRaw = cell("首提交", 10).trim()
    const penaltyRaw = parseCell(cell("修正标签", 11)).text || cell("修正标签", 11)
    const dateOk = (v) => /^\d{4}-\d{2}-\d{2}/.test(v)
    const homepage = pluginCell.links[0]?.url || download.links[0]?.url || ""
    const platform = platformOf(homepage)
    const { stars, legacy } = parseStarCell(starRaw)
    const dirMatch = pluginCell.text.match(/\(([^)]+)\)/)
    rows.push({
      ...tierInfo,
      layer: normalizeLayer(layerRaw, tierInfo.tier),
      name: pluginCell.text.replace(/\s*\([^)]*\)\s*$/, "").trim(),
      dir: dirMatch ? dirMatch[1].trim() : pluginCell.text.trim(),
      type,
      author: author.text,
      authorUrl: author.links[0]?.url || "",
      desc: desc.text,
      homepage,
      downloads: download.links.map((i) => i.url),
      checkDate: checkDate || "",
      hash: hash === "—" || hash === "-" ? "" : hash,
      note,
      // star 快照随审计更新，按仓库平台分别记录；主平台取值进口碑分，未填（—/空）为 null
      platform,
      stars,
      star: Number.isFinite(stars[platform]) ? stars[platform] : legacy,
      repoKey: repoKeyOf(homepage),
      // U/A/P 数据源（契约 §5.2）：最后提交/首提交为 YYYY-MM-DD 日期，修正标签为文本（过时依赖/不兼容）
      lastCommit: dateOk(lastCommitRaw) ? lastCommitRaw.slice(0, 10) : "",
      firstCommit: dateOk(firstCommitRaw) ? firstCommitRaw.slice(0, 10) : "",
      penalties: penaltyRaw === "—" || penaltyRaw === "-" ? "" : String(penaltyRaw || "").trim(),
    })
  }
  const repoCount = new Map()
  for (const row of rows) {
    if (!row.repoKey) continue
    repoCount.set(row.repoKey, (repoCount.get(row.repoKey) || 0) + 1)
  }
  const starHeader = headers?.find((h) => /star/i.test(h)) || ""
  const starSnapshot = (starHeader.match(/\d{4}-\d{2}-\d{2}/) || [""])[0]
  for (const row of rows) {
    row.collection = row.repoKey ? repoCount.get(row.repoKey) || 1 : 0
    row.starSnapshot = starSnapshot
  }
  return rows
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))
  } catch {
    return null
  }
}

function writeCache(text, source) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ at: Date.now(), source, text }),
    )
  } catch {}
}

/** 配置覆盖：panel.ledger.layers = { 目录名或插件名: L1/L2/L3 }，优先于台账「层」列 */
function applyLayers(items, conf) {
  const map = conf?.layers && typeof conf.layers === "object" ? conf.layers : {}
  for (const row of items) {
    const v = map[row.dir] ?? map[row.name]
    if (v != null && v !== "") row.layer = normalizeLayer(v, row.tier)
  }
  return items
}

/** 取台账；force 时忽略内存缓存重新拉取 */
export async function getLedger(force = false) {
  const conf = panelConf().ledger || {}
  const ttl = Math.max(1, Number(conf.cacheMinutes) || 30) * 60000
  const parse = (text) => applyLayers(parseLedger(text), conf)

  if (!force && memory && Date.now() - memory.at < ttl) return memory

  const local = String(conf.localPath || "").trim()
  if (local && fs.existsSync(local)) {
    const text = fs.readFileSync(local, "utf8")
    writeCache(text, `local:${local}`)
    memory = { at: Date.now(), source: `local:${local}`, stale: false, items: parse(text) }
    return memory
  }

  const cache = readCache()
  if (!force && cache?.text && Date.now() - cache.at < ttl) {
    memory = { at: cache.at, source: "cache", stale: false, items: parse(cache.text) }
    return memory
  }

  try {
    const url = conf.url
    if (!url) throw new Error("未配置台账地址")
    const res = await fetch(url, { timeout: 15000 })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // 显式按 UTF-8 解码：台账文件是 UTF-8，不信任响应头里的 charset 声明，避免中文被按错误编码解出乱码
    const text = Buffer.from(await res.arrayBuffer()).toString("utf8")
    if (!/\|/.test(text)) throw new Error("返回内容不是表格")
    writeCache(text, "remote")
    memory = { at: Date.now(), source: "remote", stale: false, items: parse(text) }
    return memory
  } catch (err) {
    const fallbackText = cache?.text || ""
    memory = {
      at: cache?.at || 0,
      source: cache?.source || "none",
      stale: true,
      error: String(err.message || err),
      items: parse(fallbackText),
    }
    return memory
  }
}

/** 按插件目录名/名称精确查台账条目；不做模糊包含，避免 adapter 误配到 *-Adapter */
export function findEntry(items, dir) {
  const key = String(dir || "").toLowerCase()
  if (!key) return null
  return (
    items.find((i) => i.dir.toLowerCase() === key) ||
    items.find((i) => i.name.toLowerCase() === key) ||
    null
  )
}

export { panelConf }
