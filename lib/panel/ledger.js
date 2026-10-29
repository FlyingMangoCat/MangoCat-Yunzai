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
  if (/官方/.test(text) || text.includes("🟢")) return { tier: "official", label: "官方" }
  if (/已收录/.test(text) || text.includes("🟡")) return { tier: "audited", label: "已收录" }
  return { tier: "unknown", label: "未审核" }
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
    const dirMatch = pluginCell.text.match(/\(([^)]+)\)/)
    rows.push({
      ...tierOf(grade),
      name: pluginCell.text.replace(/\s*\([^)]*\)\s*$/, "").trim(),
      dir: dirMatch ? dirMatch[1].trim() : pluginCell.text.trim(),
      type,
      author: author.text,
      authorUrl: author.links[0]?.url || "",
      desc: desc.text,
      homepage: pluginCell.links[0]?.url || download.links[0]?.url || "",
      downloads: download.links.map((i) => i.url),
      checkDate: checkDate || "",
      hash: hash === "—" || hash === "-" ? "" : hash,
      note,
      // star 月度快照由维护者手工填入台账；未填（—/空）按 null 处理，不参与口碑分
      star: /^\d+$/.test(starRaw) ? Number(starRaw) : null,
    })
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

/** 取台账；force 时忽略内存缓存重新拉取 */
export async function getLedger(force = false) {
  const conf = panelConf().ledger || {}
  const ttl = Math.max(1, Number(conf.cacheMinutes) || 30) * 60000

  if (!force && memory && Date.now() - memory.at < ttl) return memory

  const local = String(conf.localPath || "").trim()
  if (local && fs.existsSync(local)) {
    const text = fs.readFileSync(local, "utf8")
    writeCache(text, `local:${local}`)
    memory = { at: Date.now(), source: `local:${local}`, stale: false, items: parseLedger(text) }
    return memory
  }

  const cache = readCache()
  if (!force && cache?.text && Date.now() - cache.at < ttl) {
    memory = { at: cache.at, source: "cache", stale: false, items: parseLedger(cache.text) }
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
    memory = { at: Date.now(), source: "remote", stale: false, items: parseLedger(text) }
    return memory
  } catch (err) {
    const fallbackText = cache?.text || ""
    memory = {
      at: cache?.at || 0,
      source: cache?.source || "none",
      stale: true,
      error: String(err.message || err),
      items: parseLedger(fallbackText),
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
