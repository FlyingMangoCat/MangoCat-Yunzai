import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { getLedger, findEntry, installConf } from "./ledger.js"
import { ensureRemoteUsable } from "../tools/gitSource.js"
import { requestConfirm } from "../security/sensitiveOps.js"

/**
 * 插件管理
 *
 * 只做三件事：列目录、读 README、执行 git 的克隆/拉取/移走。
 * 安装与更新的信任判定全部以收录台账为准：
 * - 台账内的插件：官方免审，已收录只信任台账记录的版本哈希；
 * - 台账外：安装/更新前必须经过二次风险确认；
 * - 仓库域名必须在 panel.install.domains 白名单内，避免面板被当作任意地址下载器。
 * 安装/卸载/更新在执行前都要经主人私聊确认，与敏感操作门禁同一套确认流程。
 */

const run = promisify(execFile)
const PLUGIN_DIR = path.resolve("plugins")
const REMOVED_DIR = path.resolve("data/panel_removed")
const AUDIT_FILE = path.resolve("data/panel/audit.log")

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function gitHead(dir) {
  const gitDir = path.join(dir, ".git")
  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim()
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim()
      const refFile = path.join(gitDir, ref)
      if (fs.existsSync(refFile)) return fs.readFileSync(refFile, "utf8").trim()
      const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8")
      const line = packed.split("\n").find((i) => i.endsWith(` ${ref}`))
      if (line) return line.split(" ")[0].trim()
      return ""
    }
    return head
  } catch {
    return ""
  }
}

/** 插件目录最近一次 git 提交时间（ISO）；非 git 目录回落到目录修改时间，供「已安装」视图按更新时间排序 */
function gitTime(dir) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cI"], { cwd: dir, timeout: 5000 }).toString().trim()
    if (out) return out
  } catch {}
  try {
    return fs.statSync(dir).mtime.toISOString()
  } catch {
    return ""
  }
}

const RESERVED_PLUGIN_DIRS = new Set(["adapter", "data", "example", "other", "system"])

/** 只有包含 index.js/package.json/顶层或 apps 下 JS 的目录才算插件；排除本体保留目录 */
function isPluginDir(name) {
  if (!name || name.startsWith(".") || RESERVED_PLUGIN_DIRS.has(name) || ["node_modules", ".git"].includes(name)) return false
  const dir = path.join(PLUGIN_DIR, name)
  if (!isDir(dir)) return false
  if (fs.existsSync(path.join(dir, "index.js")) || fs.existsSync(path.join(dir, "package.json"))) return true
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    if (entries.some((e) => e.isFile() && /\.(?:js|mjs|cjs)$/i.test(e.name))) return true
    const apps = entries.find((e) => e.isDirectory() && e.name === "apps")
    if (apps && fs.readdirSync(path.join(dir, "apps"), { withFileTypes: true }).some((e) => e.isFile() && /\.(?:js|mjs|cjs)$/i.test(e.name))) {
      return true
    }
  } catch {}
  return false
}

function pluginDirs() {
  if (!isDir(PLUGIN_DIR)) return []
  return fs
    .readdirSync(PLUGIN_DIR)
    .filter(isPluginDir)
    .sort()
}

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
  } catch {
    return {}
  }
}

/** 从插件自带 plugin.yaml 推断合规层：isolation→L3，permissions→L2，仅 manifest→L1，无 manifest→null */
function manifestLayer(dir) {
  for (const file of ["plugin.yaml", "plugin.yml"]) {
    const p = path.join(dir, file)
    if (!fs.existsSync(p)) continue
    try {
      const m = YAML.parse(fs.readFileSync(p, "utf8")) || {}
      if (m.isolation) return "L3"
      const perms = m.permissions
      const hasPerms = Array.isArray(perms)
        ? perms.length > 0
        : perms && typeof perms === "object"
          ? Object.keys(perms).length > 0
          : Boolean(perms)
      return hasPerms ? "L2" : "L1"
    } catch {
      return "L1"
    }
  }
  return null
}

/** 列插件：本地信息 + 台账条目 + 版本哈希是否与台账一致 */
export async function listPlugins() {
  const ledger = await getLedger()
  // 展示顺序跟台账文件条目先后一致（先收录的在前）；台账外的插件排在末尾，按目录名稳定排列
  const ledgerIndex = (name) => {
    const key = name.toLowerCase()
    const idx = ledger.items.findIndex(
      (i) => i.dir.toLowerCase() === key || i.name.toLowerCase() === key,
    )
    return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER
  }
  const dirs = pluginDirs().map((name) => ({ name, dir: path.join(PLUGIN_DIR, name) }))
  const items = dirs
    .map(({ name, dir }) => {
      const pkg = readPkg(dir)
      const head = gitHead(dir)
      const entry = findEntry(ledger.items, name)
      const shortHead = head.slice(0, 7)
      let hashState = "none"
      if (entry?.hash) {
        if (!head) hashState = "unknown"
        else if (head.startsWith(entry.hash) || entry.hash.startsWith(shortHead)) hashState = "match"
        else hashState = "ahead"
      }
      return {
        name,
        title: pkg.description ? name : name,
        version: pkg.version || "",
        description: pkg.description || "",
        head: shortHead,
        lastCommit: gitTime(dir),
        hasReadme: fs.existsSync(path.join(dir, "README.md")) || fs.existsSync(path.join(dir, "readme.md")),
        hasGuoba: fs.existsSync(path.join(dir, "guoba.support.js")),
        updatedAt: (() => {
          try {
            return fs.statSync(dir).mtime.toISOString()
          } catch {
            return ""
          }
        })(),
        tier: entry?.tier || "unknown",
        tierLabel: entry?.label || "未审核",
        layer:
          manifestLayer(dir) ||
          (entry?.tier === "unknown" || entry?.tier === "retired" ? "L0" : entry?.layer || "L1"),
        ledgerDir: entry?.dir || "",
        ledgerName: entry?.name || "",
        ledger: entry
          ? {
              author: entry.author,
              checkDate: entry.checkDate,
              hash: entry.hash,
              note: entry.note,
              homepage: entry.homepage,
              downloads: entry.downloads,
            }
          : null,
        hashState,
      }
    })
    .sort((a, b) => ledgerIndex(a.name) - ledgerIndex(b.name) || a.name.localeCompare(b.name))
  // 已安装判定与信任判定同一套匹配：本地插件归并到的台账条目即视为已安装
  const installedByLedger = new Set(items.filter((i) => i.ledgerDir).map((i) => i.ledgerDir))
  // 已安装插件优先用 manifest 推断的 layer，其余沿用台账/配置
  const layerByKey = new Map()
  for (const it of items) {
    layerByKey.set(it.name, it.layer)
    if (it.ledgerDir) layerByKey.set(it.ledgerDir, it.layer)
  }
  const catalog = ledger.items.map((i) => ({
    tier: i.tier,
    tierLabel: i.label || "未审核",
    layer:
      layerByKey.get(i.dir) ||
      layerByKey.get(i.name) ||
      i.layer ||
      (i.tier === "unknown" || i.tier === "retired" ? "L0" : "L1"),
    name: i.name,
    dir: i.dir,
    author: i.author,
    type: i.type || "",
    desc: i.desc,
    checkDate: i.checkDate,
    hash: i.hash,
    note: i.note,
    homepage: i.homepage,
    downloads: i.downloads,
    // star 快照随审计更新，来自台账 Star 列（未填为 null）；platform 以主页仓库所在平台为准，供口碑分按平台 K 归一
    star: Number.isFinite(i.star) ? i.star : null,
    stars: i.stars || {},
    collection: i.collection || 0,
    starSnapshot: i.starSnapshot || "",
    // U/A/P 数据源（契约 §5.2），台账缺值为空串，前端按 — 显示
    lastCommit: i.lastCommit || "",
    firstCommit: i.firstCommit || "",
    penalties: i.penalties || "",
    platform: i.platform || (/github/i.test(`${i.homepage} ${(i.downloads || []).join(" ")}`) ? "github" : "gitee"),
    installed: installedByLedger.has(i.dir) || installedByLedger.has(i.name),
  }))
  return {
    ledger: { at: ledger.at, source: ledger.source, stale: !!ledger.stale, error: ledger.error || "" },
    items,
    catalog,
  }
}

const ASSET_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".avif"])

/** README 内嵌图片：只允许插件目录内的图片文件，防路径穿越与符号链接逃逸 */
export function resolvePluginAsset(name, relPath) {
  if (!pluginDirs().includes(name)) throw new Error("插件不存在")
  const rel = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "")
  if (!rel || rel.includes("\0")) throw new Error("资源路径不合法")
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.split("/").includes("..")) {
    throw new Error("资源路径不合法")
  }
  const ext = path.extname(rel).toLowerCase()
  if (!ASSET_EXT.has(ext)) throw new Error("不支持的资源类型")
  const root = fs.realpathSync(path.join(PLUGIN_DIR, name))
  let real
  try {
    real = fs.realpathSync(path.resolve(root, rel))
  } catch {
    throw new Error("资源不存在")
  }
  const inside = path.relative(root, real)
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("资源路径不合法")
  if (!fs.statSync(real).isFile()) throw new Error("资源不存在")
  return { path: real, ext }
}

export function readReadme(name) {
  if (!pluginDirs().includes(name)) throw new Error("插件不存在")
  const dir = path.join(PLUGIN_DIR, name)
  for (const file of ["README.md", "readme.md", "Readme.md"]) {
    const full = path.join(dir, file)
    if (fs.existsSync(full)) {
      const text = fs.readFileSync(full, "utf8")
      return { name, file, text: text.slice(0, 300 * 1024), truncated: text.length > 300 * 1024 }
    }
  }
  throw new Error("该插件没有 README.md")
}

function verifyUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error("仓库地址格式不正确")
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("只允许 http/https 仓库地址")
  if (String(url).trim().startsWith("-")) throw new Error("仓库地址不合法")
  const domains = installConf().domains || []
  const host = parsed.hostname.toLowerCase()
  if (!domains.some((d) => host === String(d).toLowerCase() || host.endsWith(`.${String(d).toLowerCase()}`))) {
    throw new Error(`仓库域名不在白名单内：${host}`)
  }
  return host
}

function dirNameOf(url) {
  const clean = String(url).replace(/\/+$/, "").replace(/\.git$/i, "")
  const name = clean.split("/").pop() || ""
  if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") throw new Error("无法从地址解析插件目录名")
  return name
}

/** 审计行：面板自身记录敏感操作，与实体日志分离，便于回溯 */
export function audit(action, target, result, req) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true })
    const line = JSON.stringify({
      t: new Date().toISOString(),
      action,
      target,
      result,
      ip: req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "",
    })
    fs.appendFileSync(AUDIT_FILE, `${line}\n`)
  } catch {}
}

export function readAudit(limit = 50) {
  try {
    const lines = fs.readFileSync(AUDIT_FILE, "utf8").trim().split("\n").filter(Boolean)
    return lines
      .slice(-Math.min(500, Math.max(1, Number(limit) || 50)))
      .reverse()
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

async function confirmMaster(action, req) {
  const ip = req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "未知来源"
  const ok = await requestConfirm(action, `${ip}（面板 HTTP 请求）`)
  if (!ok) throw new Error("操作已取消：未获得主人私聊确认")
}

export async function installPlugin({ url, ack, req }) {
  const conf = installConf()
  if (conf.allow === false) throw new Error("面板已关闭插件安装（panel.install.allow）")
  verifyUrl(url)
  const name = dirNameOf(url)
  const target = path.join(PLUGIN_DIR, name)
  if (fs.existsSync(target)) throw new Error(`插件目录已存在：plugins/${name}`)

  const ledger = await getLedger()
  const entry = findEntry(ledger.items, name)
  if (!entry && ack !== true) {
    throw new Error("该插件未收录（未审核），安装后可能带来安全风险，后果自负；需风险确认后继续")
  }

  await confirmMaster(`安装插件 ${url}`, req)
  const started = Date.now()
  let output = ""
  try {
    const res = await run("git", ["clone", "--depth", "1", url, target], {
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    output = `${res.stdout || ""}${res.stderr || ""}`.trim().slice(-4000)
  } catch (err) {
    audit("install", url, `失败: ${err.message}`, req)
    throw new Error(`克隆失败：${String(err.stderr || err.message).slice(0, 500)}`)
  }
  audit("install", url, `成功: plugins/${name}`, req)
  return { dir: name, tier: entry?.tier || "unknown", output, ms: Date.now() - started, needRestart: true }
}

export async function updatePlugin({ name, ack, req }) {
  if (!pluginDirs().includes(name)) throw new Error("插件不存在")
  const dir = path.join(PLUGIN_DIR, name)
  if (!isDir(path.join(dir, ".git"))) throw new Error("该插件不是 git 仓库，无法更新")

  // 未合并冲突会让 pull 直接失败，先预检给出可操作的指引
  try {
    const st = await run("git", ["-C", dir, "status", "--porcelain"], { timeout: 15000, windowsHide: true })
    const unmerged = (st.stdout || "").split("\n").filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(l.trim()))
    if (unmerged.length) {
      throw new Error(
        `该插件目录存在 ${unmerged.length} 个未解决的合并冲突文件，普通更新无法进行；请先处理冲突，或对本体发送 #强制更新 直接对齐远端`,
      )
    }
  } catch (err) {
    if (err.message.includes("未解决的合并冲突")) throw err
  }

  const ledger = await getLedger()
  const entry = findEntry(ledger.items, name)
  const head = gitHead(dir)
  if (!entry && ack !== true) {
    throw new Error("该插件未收录（未审核），更新后可能引入未知风险，后果自负；需风险确认后继续")
  }
  if (entry?.hash && head && !head.startsWith(entry.hash) && entry.hash !== head.slice(0, 7) && ack !== true) {
    throw new Error(`当前版本 ${head.slice(0, 7)} 已超出台账记录 ${entry.hash}，需风险确认后再更新`)
  }

  await confirmMaster(`更新插件 ${name}`, req)
  // pull 前探活：远端失效时按台账收录地址换源，全部不可用给出可读错误
  // （远端 404/转私有/风控时 gitee 要求输用户名，GIT_TERMINAL_PROMPT=0 下表现为
  // could not read Username，用户看不出真实原因，必须在拉取前拦下）
  try {
    await ensureRemoteUsable({
      dir,
      candidates: [...(entry?.downloads || []), entry?.homepage].filter(Boolean),
      log: (m) => global.logger?.mark?.(`[面板更新] ${name} ${m}`),
    })
  } catch (err) {
    audit("update", name, `失败: ${err.message}`, req)
    throw new Error(`更新失败：${err.message}`)
  }
  let output = ""
  try {
    const res = await run("git", ["-C", dir, "pull", "--ff-only"], {
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    output = `${res.stdout || ""}${res.stderr || ""}`.trim().slice(-4000)
  } catch (err) {
    audit("update", name, `失败: ${err.message}`, req)
    throw new Error(`更新失败：${String(err.stderr || err.message).slice(0, 500)}`)
  }
  audit("update", name, "成功", req)
  return { dir: name, output, needRestart: true }
}

export async function uninstallPlugin({ name, req }) {
  if (!pluginDirs().includes(name)) throw new Error("插件不存在")
  const dir = path.join(PLUGIN_DIR, name)
  await confirmMaster(`卸载插件 ${name}`, req)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dest = path.join(REMOVED_DIR, `${name}-${stamp}`)
  try {
    fs.mkdirSync(REMOVED_DIR, { recursive: true })
    fs.renameSync(dir, dest)
  } catch (err) {
    audit("uninstall", name, `失败: ${err.message}`, req)
    throw new Error(`移动插件目录失败：${err.message}`)
  }
  audit("uninstall", name, `已移动到 ${dest}`, req)
  return { dir: name, movedTo: dest, needRestart: true }
}

export { verifyUrl, installConf }
