import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * 帮助菜单（miao-plugin）
 *
 * 喵喵的帮助数据来自插件内 config/help.js（用户自定义）或 config/help_default.js（模板），
 * 两者都是 ESM 模块，导出 helpCfg（分组样式/展示开关）与 helpList（分组与条目）。
 * 面板读取时动态 import 用户文件并带 mtime 参数破缓存；写入时先把当前内容备份到
 * data/panel_backup/，再按原导出名重新生成为 help.js，保存后由喵喵自身的热加载生效。
 */

const PLUGIN_DIR = path.resolve("plugins")

function helpPaths(plugin = "miao-plugin") {
  const base = path.join(PLUGIN_DIR, plugin, "config")
  return { userFile: path.join(base, "help.js"), defFile: path.join(base, "help_default.js") }
}

export function helpAvailable(plugin = "miao-plugin") {
  const { userFile, defFile } = helpPaths(plugin)
  return fs.existsSync(userFile) || fs.existsSync(defFile)
}

async function importHelp(file) {
  if (!fs.existsSync(file)) return null
  const mtime = fs.statSync(file).mtimeMs
  const mod = await import(`${pathToFileURL(file).href}?t=${mtime}`)
  return { helpCfg: mod.helpCfg || {}, helpList: mod.helpList || [] }
}

export async function readHelp(plugin = "miao-plugin") {
  const { userFile, defFile } = helpPaths(plugin)
  if (fs.existsSync(userFile)) {
    const data = await importHelp(userFile)
    return { available: true, fromDefault: false, ...data }
  }
  if (fs.existsSync(defFile)) {
    const data = await importHelp(defFile)
    return { available: true, fromDefault: true, ...data }
  }
  return { available: false, fromDefault: true, helpCfg: {}, helpList: [] }
}

function stringify(value) {
  return JSON.stringify(value, null, 2)
}

function backup(file) {
  if (!fs.existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dest = path.join("data/panel_backup", stamp, "help.js")
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(file, dest)
  return dest
}

/** 保存帮助配置；校验 helpList 每组有 group 名、每个条目有 title */
export async function writeHelp(payload = {}, plugin = "miao-plugin") {
  const { userFile, defFile } = helpPaths(plugin)
  if (!fs.existsSync(userFile) && !fs.existsSync(defFile)) throw new Error("未检测到喵喵帮助配置文件")
  const helpCfg = payload.helpCfg && typeof payload.helpCfg === "object" ? payload.helpCfg : {}
  const helpList = Array.isArray(payload.helpList) ? payload.helpList : []
  for (const group of helpList) {
    if (!group || typeof group !== "object") throw new Error("帮助分组格式错误")
    if (!group.group) throw new Error("帮助分组缺少 group 字段")
    if (group.list && !Array.isArray(group.list)) throw new Error("帮助分组 list 必须是数组")
  }
  const source = `export const helpCfg = ${stringify(helpCfg)}\n\nexport const helpList = ${stringify(helpList)}\n`
  const dest = backup(fs.existsSync(userFile) ? userFile : defFile)
  fs.mkdirSync(path.dirname(userFile), { recursive: true })
  const tmp = `${userFile}.tmp-${process.pid}`
  fs.writeFileSync(tmp, source, "utf8")
  fs.renameSync(tmp, userFile)
  return { backup: dest, file: userFile }
}
