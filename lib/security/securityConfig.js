import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

/**
 * 安全配置读取（磁盘快照 + 短期缓存）
 *
 * 审计策略与敏感操作门禁不能读 cfg 的内存缓存：插件可以在运行期修改
 * cfg.getConfig("security") 关闭规则/门禁。这里直接读受 fsGuard 保护的
 * 配置文件，并快照启动时的原生读取/解析函数。
 */

const readFileSync = fs.readFileSync.bind(fs)
const parseYaml = YAML.parse.bind(YAML)
const nativeFreeze = Object.freeze
const nativeKeys = Object.keys
const FILES = {
  def: path.resolve("config/default_config/security.yaml"),
  user: path.resolve("config/config/security.yaml"),
}
const CACHE_MS = 2000
let cache = nativeFreeze({ at: 0, def: nativeFreeze({}), user: nativeFreeze({}) })

function deepFreeze(value) {
  if (!value || typeof value !== "object") return value
  for (const key of nativeKeys(value)) deepFreeze(value[key])
  return nativeFreeze(value)
}

function load(file) {
  try {
    const parsed = parseYaml(readFileSync(file, "utf8")) || {}
    return deepFreeze(parsed)
  } catch {
    return {}
  }
}

export function readSecurityConfig() {
  if (Date.now() - cache.at < CACHE_MS) return cache
  const def = load(FILES.def)
  const user = load(FILES.user)
  cache = nativeFreeze({ at: Date.now(), def, user })
  return cache
}
