import fs from "node:fs"
import path from "node:path"

/**
 * 运行日志读取
 *
 * 只读 logs/ 下的 log4js 日志文件，按时间倒序给出文件列表，取尾部若干行；
 * 支持按 level 过滤（error/warn/mark/info/debug），不提供删除或写入。
 */

const LOG_DIR = path.resolve("logs")

export function listLogs() {
  try {
    return fs
      .readdirSync(LOG_DIR)
      .filter((name) => name.endsWith(".log"))
      .map((name) => {
        const stat = fs.statSync(path.join(LOG_DIR, name))
        return { name, size: stat.size, mtime: stat.mtime.toISOString() }
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  } catch {
    return []
  }
}

const LEVEL_RE = /\[(error|warn|mark|info|debug)\]/i

/** 读取日志尾部；file 必须是 listLogs 中的文件名，避免拼路径读其它文件 */
export function readLogs({ file = "", level = "", limit = 300 } = {}) {
  const files = listLogs()
  const target = files.find((i) => i.name === file) || files[0]
  if (!target) return { file: "", lines: [], files: [] }
  const full = path.join(LOG_DIR, target.name)
  let text = ""
  try {
    const stat = fs.statSync(full)
    const size = stat.size
    const readSize = Math.min(size, 512 * 1024)
    const fd = fs.openSync(full, "r")
    const buffer = Buffer.alloc(readSize)
    fs.readSync(fd, buffer, 0, readSize, size - readSize)
    fs.closeSync(fd)
    text = buffer.toString("utf8")
    // 截断点可能落在行中间，丢掉首个不完整行
    if (readSize < size) text = text.slice(text.indexOf("\n") + 1)
  } catch {
    text = ""
  }
  const wanted = String(level || "").toLowerCase()
  let lines = text.split(/\r?\n/).filter(Boolean)
  if (wanted) lines = lines.filter((line) => (line.match(LEVEL_RE)?.[1] || "").toLowerCase() === wanted)
  const max = Math.min(2000, Math.max(1, Number(limit) || 300))
  return { file: target.name, files, lines: lines.slice(-max), total: lines.length }
}
