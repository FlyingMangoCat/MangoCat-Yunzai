import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { pathToFileURL } from "node:url"

/**
 * 配置读写
 *
 * 三条来源按优先级排列：
 * 1. 插件自有 YAML 配置（如 liulian-plugin 的 config/config/<模块>/<文件>.yaml），
 *    用户配置不存在时读同结构的 default_config 模板，页面按 YAML 结构生成表单；
 * 2. 插件自带锅巴 schema（guoba.support.js 的 configInfo.schemas），按其控件定义渲染；
 * 3. 本体 config/default_config 下的基础配置。
 *
 * 写入使用 yaml 的 Document API 在内存文档上定位字段后回写，保留原有缩进与注释行；
 * 保存前先做一次 YAML.parse 校验，不通过直接拒绝；原文件备份到 data/panel_backup/<时间>/。
 */

const ROOT = process.cwd()
const BACKUP_DIR = path.resolve("data/panel_backup")
const PLUGIN_DIR = path.resolve("plugins")

// 敏感字段：读取时值不落前端，写入时留空视为不修改
const SENSITIVE = /(pass(word|wd)?|pwd|token|secret|api[_-]?key|apikey|cookie|credential)/i

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function walkYaml(dir, prefix = "", out = []) {
  if (!isDir(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue
    const full = path.join(dir, name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      walkYaml(full, prefix ? `${prefix}/${name}` : name, out)
    } else if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      out.push(prefix ? `${prefix}/${name}` : name)
    }
  }
  return out
}

function pluginList() {
  if (!isDir(PLUGIN_DIR)) return []
  return fs
    .readdirSync(PLUGIN_DIR)
    .filter((name) => !["node_modules", ".git"].includes(name) && isDir(path.join(PLUGIN_DIR, name)))
    .sort()
}

function pluginTitle(name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, name, "package.json"), "utf8"))
    return pkg?.description ? `${name}` : name
  } catch {
    return name
  }
}

/** 所有可管理来源：本体 + 插件（YAML 型 / 锅巴 schema 型） */
export function sources() {
  const list = []

  const yunzaiFiles = new Set()
  for (const rel of walkYaml(path.resolve("config/default_config"))) yunzaiFiles.add(rel)
  for (const rel of walkYaml(path.resolve("config/config"))) yunzaiFiles.add(rel)
  if (yunzaiFiles.size) {
    list.push({
      id: "yunzai",
      title: "MangoCat-Yunzai 本体",
      kind: "yaml",
      files: [...yunzaiFiles].sort().map((rel) => ({ key: rel, title: rel.replace(/\.ya?ml$/, "") })),
    })
  }

  for (const name of pluginList()) {
    const base = path.join(PLUGIN_DIR, name)
    const userFiles = walkYaml(path.join(base, "config/config"))
    const defFiles = walkYaml(path.join(base, "config/default_config"))
    const all = [...new Set([...userFiles, ...defFiles])].sort()
    if (all.length) {
      list.push({
        id: `plugin:${name}`,
        title: pluginTitle(name),
        kind: "yaml",
        files: all.map((rel) => ({ key: rel, title: rel.replace(/\.ya?ml$/, "") })),
      })
      continue
    }
    if (fs.existsSync(path.join(base, "guoba.support.js"))) {
      list.push({
        id: `schema:${name}`,
        title: pluginTitle(name),
        kind: "schema",
        files: [{ key: "config", title: "插件配置" }],
      })
    }
  }

  return list
}

function fileInfo(sourceId, fileKey) {
  if (sourceId === "yunzai") {
    return {
      userFile: path.resolve("config/config", fileKey),
      defFile: path.resolve("config/default_config", fileKey),
      rel: `config/config/${fileKey}`,
    }
  }
  if (sourceId.startsWith("plugin:")) {
    const name = sourceId.slice("plugin:".length)
    return {
      userFile: path.join(PLUGIN_DIR, name, "config/config", fileKey),
      defFile: path.join(PLUGIN_DIR, name, "config/default_config", fileKey),
      rel: `plugins/${name}/config/config/${fileKey}`,
    }
  }
  return null
}

function cleanHint(text) {
  if (!text) return ""
  return String(text)
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
}

function hintOf(doc, p) {
  try {
    const node = doc.getIn(p, true)
    return cleanHint(node?.comment || node?.commentBefore || "")
  } catch {
    return ""
  }
}

function fieldType(value) {
  if (typeof value === "boolean") return "switch"
  if (typeof value === "number") return "number"
  if (Array.isArray(value)) return "list"
  if (value === null || value === undefined) return "text"
  if (typeof value === "string" && (value.includes("\n") || value.length > 80)) return "textarea"
  return "text"
}

/** 按 YAML 结构生成表单描述；对象递归成分组，敏感值不回传 */
function buildFields(doc, value, prefix = []) {
  const fields = []
  if (!value || typeof value !== "object" || Array.isArray(value)) return fields
  for (const [key, val] of Object.entries(value)) {
    const p = [...prefix, key]
    const label = key
    if (val && typeof val === "object" && !Array.isArray(val)) {
      fields.push({
        type: "group",
        label,
        key,
        path: p,
        hint: hintOf(doc, p),
        children: buildFields(doc, val, p),
      })
      continue
    }
    const sensitive = SENSITIVE.test(key)
    const item = {
      type: fieldType(val),
      key,
      path: p,
      label,
      hint: hintOf(doc, p),
      sensitive,
    }
    if (item.type === "list") {
      item.items = (Array.isArray(val) ? val : []).map((i) => (typeof i === "object" ? JSON.stringify(i) : String(i)))
    } else if (sensitive) {
      item.value = ""
      item.set = val !== "" && val !== null && val !== undefined
    } else {
      item.value = val === null || val === undefined ? "" : val
    }
    fields.push(item)
  }
  return fields
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/** 读 YAML 来源：返回表单描述与当前值（敏感字段只返回"已设置"标记） */
export function readYamlSource(sourceId, fileKey) {
  const info = fileInfo(sourceId, fileKey)
  if (!info) throw new Error("未知配置来源")
  const userExists = fs.existsSync(info.userFile)
  const defExists = fs.existsSync(info.defFile)
  if (!userExists && !defExists) throw new Error("配置文件不存在")
  const file = userExists ? info.userFile : info.defFile
  const text = readText(file)
  let doc
  try {
    doc = YAML.parseDocument(text || "{}\n")
    if (doc.errors?.length) throw doc.errors[0]
  } catch (err) {
    throw new Error(`配置文件解析失败：${err.message}`)
  }
  return {
    source: sourceId,
    file: fileKey,
    title: fileKey.replace(/\.ya?ml$/, ""),
    fromDefault: !userExists,
    updatedAt: fs.statSync(file).mtime.toISOString(),
    fields: buildFields(doc, doc.toJS() || {}),
  }
}

function coerceValue(value, current) {
  if (Array.isArray(current)) {
    if (Array.isArray(value)) return value.map(String)
    if (typeof value === "string") {
      return value
        .split("\n")
        .map((i) => i.trim())
        .filter(Boolean)
    }
    return []
  }
  if (typeof current === "boolean") return value === true || value === "true"
  if (typeof current === "number") {
    const n = Number(value)
    if (!Number.isFinite(n)) throw new Error("需要数字")
    return n
  }
  // 键不存在或原值为空：按传入类型写入，数字/布尔不被转成字符串
  if (current === undefined || current === null) {
    if (value === null || value === undefined) return ""
    if (typeof value === "number" || typeof value === "boolean") return value
    if (Array.isArray(value)) return value.map(String)
    return String(value)
  }
  if (value === null || value === undefined) return ""
  return String(value)
}

function backupFile(file, sourceId, fileKey) {
  if (!fs.existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const dest = path.join(BACKUP_DIR, stamp, sourceId.replace(/[:]/g, "_"), fileKey)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(file, dest)
  return dest
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, "utf8")
  fs.renameSync(tmp, file)
}

/**
 * 写 YAML 来源
 * @param patches 仅包含改动字段：[{ path: ["ai","probability","group"], value: 50 }]
 * 敏感字段留空（""）视为不修改；未出现在 patches 里的字段原样保留
 */
export function writeYamlSource(sourceId, fileKey, patches) {
  const info = fileInfo(sourceId, fileKey)
  if (!info) throw new Error("未知配置来源")
  if (!Array.isArray(patches) || !patches.length) throw new Error("没有需要保存的字段")
  const userExists = fs.existsSync(info.userFile)
  const baseFile = userExists ? info.userFile : info.defFile
  if (!fs.existsSync(baseFile)) throw new Error("配置文件不存在")
  const text = readText(baseFile)
  const doc = YAML.parseDocument(text || "{}\n")
  if (doc.errors?.length) throw new Error(`配置文件解析失败：${doc.errors[0].message}`)

  for (const patch of patches) {
    const p = Array.isArray(patch.path) ? patch.path.map(String) : null
    if (!p?.length) continue
    const key = p[p.length - 1]
    if (SENSITIVE.test(key) && (patch.value === "" || patch.value === null)) continue
    const current = doc.getIn(p)
    doc.setIn(p, coerceValue(patch.value, current))
  }

  const out = String(doc)
  try {
    YAML.parse(out)
  } catch (err) {
    throw new Error(`写入内容不是合法 YAML，已拒绝保存：${err.message}`)
  }
  const backup = backupFile(info.userFile, sourceId, fileKey)
  atomicWrite(info.userFile, out)
  return { backup, file: info.rel }
}

/* ---------------- 群组覆盖（本体 group.yaml） ---------------- */

function groupFile() {
  return {
    userFile: path.resolve("config/config/group.yaml"),
    defFile: path.resolve("config/default_config/group.yaml"),
  }
}

function readGroupDoc() {
  const { userFile, defFile } = groupFile()
  const file = fs.existsSync(userFile) ? userFile : defFile
  const text = readText(file)
  const doc = YAML.parseDocument(text || "{}\n")
  if (doc.errors?.length) throw new Error(`群配置解析失败：${doc.errors[0].message}`)
  return { doc, file, fromDefault: !fs.existsSync(userFile) }
}

export function readGroups() {
  const { doc, fromDefault } = readGroupDoc()
  const values = doc.toJS() || {}
  const def = values.default || {}
  const groups = []
  for (const [key, val] of Object.entries(values)) {
    if (key === "default") continue
    if (val && typeof val === "object") groups.push({ id: key, values: val })
  }
  return {
    fromDefault,
    defaultFields: buildFields(doc, def, ["default"]),
    groups: groups.map((g) => ({ id: g.id, fields: buildFields(doc, g.values, [g.id]) })),
  }
}

export function writeGroupDefault(patches) {
  return writeYamlSource("yunzai", "group.yaml", patches)
}

/** 新增/修改某个群的覆盖项；patches 为空对象时写入空表（继承全局） */
export function writeGroup(id, patches = [], remove = false) {
  const gid = String(id || "").trim()
  if (!/^\d{5,12}$/.test(gid)) throw new Error("群号不合法")
  const { userFile, defFile } = groupFile()
  const base = fs.existsSync(userFile) ? userFile : defFile
  const doc = YAML.parseDocument(readText(base) || "{}\n")
  if (doc.errors?.length) throw new Error(`群配置解析失败：${doc.errors[0].message}`)
  if (remove) {
    doc.delete(gid)
  } else {
    for (const patch of patches) {
      const raw = Array.isArray(patch.path) ? patch.path.map(String) : []
      // 读接口返回的路径带群号前缀（default 视作模板占位），写入时统一去掉
      const rel = raw[0] === gid || raw[0] === "default" ? raw.slice(1) : raw
      if (!rel.length) continue
      const p = [gid, ...rel]
      const key = p[p.length - 1]
      if (SENSITIVE.test(key) && (patch.value === "" || patch.value === null)) continue
      doc.setIn(p, coerceValue(patch.value, doc.getIn(p)))
    }
  }
  const out = String(doc)
  YAML.parse(out)
  const backup = backupFile(userFile, "yunzai", "group.yaml")
  atomicWrite(userFile, out)
  return { backup }
}

/* ---------------- 锅巴 schema 来源（插件自带 configInfo） ---------------- */

const schemaCache = new Map()

async function loadSchemaPlugin(name) {
  if (schemaCache.has(name)) {
    const hit = schemaCache.get(name)
    if (hit?.error) throw new Error(`加载 ${name}/guoba.support.js 失败：${hit.error}（若提示不支持的内置模块，多为插件依赖与当前 Node 版本不兼容）`)
    return hit
  }
  const file = path.join(PLUGIN_DIR, name, "guoba.support.js")
  if (!fs.existsSync(file)) throw new Error("插件没有 guoba.support.js")
  let mod
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (err) {
    // 插件的 support 文件可能连带加载插件自身依赖（如依赖了当前 Node 不支持的内置模块），失败时给出可读原因
    schemaCache.set(name, { error: err.message })
    throw new Error(`加载 ${name}/guoba.support.js 失败：${err.message}（若提示不支持的内置模块，多为插件依赖与当前 Node 版本不兼容）`)
  }
  if (typeof mod.supportGuoba !== "function") throw new Error("插件未导出 supportGuoba")
  const support = await mod.supportGuoba()
  const info = support?.configInfo
  if (!info?.schemas?.length) throw new Error("插件没有提供配置 schema")
  const loaded = { info, name }
  schemaCache.set(name, loaded)
  return loaded
}

/** schema 列表拍平成页面分组：SOFT_GROUP_BEGIN 开始一组，其余为字段 */
function schemaGroups(schemas) {
  const groups = []
  let current = { title: "配置", fields: [] }
  for (const item of schemas) {
    if (item.component === "SOFT_GROUP_BEGIN" || item.component === "GROUP_BEGIN") {
      if (current.fields.length) groups.push(current)
      current = { title: item.label || "配置", fields: [] }
      continue
    }
    const type =
      item.component === "Switch"
        ? "switch"
        : item.component === "InputNumber"
          ? "number"
          : item.component === "Select"
            ? "select"
            : "text"
    current.fields.push({
      type,
      key: item.field,
      path: [item.field],
      label: item.label || item.field,
      hint: item.bottomHelpMessage || "",
      options: item.componentProps?.options || null,
      disabled: !!item.componentProps?.disabled,
      min: item.componentProps?.min,
      max: item.componentProps?.max,
    })
  }
  if (current.fields.length) groups.push(current)
  return groups
}

export async function readSchemaSource(sourceId) {
  const name = sourceId.slice("schema:".length)
  const { info } = await loadSchemaPlugin(name)
  const values = (await info.getConfigData?.()) || {}
  return {
    source: sourceId,
    file: "config",
    title: "插件配置",
    fromDefault: false,
    fields: schemaGroups(info.schemas).map((group) => ({
      ...group,
      fields: group.fields.map((field) => ({
        ...field,
        value: values[field.key] ?? "",
      })),
    })),
  }
}

function resultStub() {
  return {
    ok: (data, msg) => ({ status: "ok", data, msg }),
    error: (msg) => ({ status: "error", msg }),
  }
}

export async function writeSchemaSource(sourceId, values) {
  const name = sourceId.slice("schema:".length)
  const { info } = await loadSchemaPlugin(name)
  if (typeof info.setConfigData !== "function") throw new Error("插件不支持写入配置")
  const result = await info.setConfigData(values || {}, { Result: resultStub() })
  return { result }
}

/** 统一入口：前端按来源类型读取表单 */
export async function readConfig(sourceId, fileKey) {
  if (sourceId.startsWith("schema:")) return readSchemaSource(sourceId)
  return readYamlSource(sourceId, fileKey || "config")
}

export async function writeConfig(sourceId, fileKey, patches, values) {
  if (sourceId.startsWith("schema:")) return writeSchemaSource(sourceId, values)
  return writeYamlSource(sourceId, fileKey, patches)
}
