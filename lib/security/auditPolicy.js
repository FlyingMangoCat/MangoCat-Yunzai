import fs from "node:fs"
import path from "node:path"
import { readSecurityConfig } from "./securityConfig.js"
import { makeFindingKey } from "./findingLog.js"

/**
 * 插件审计处置策略
 *
 * mode=observe：除“确定性后门/远程代码/核心篡改/审计异常”外，其余 finding
 *   只记录、不阻断；适合上线初期收集误报。
 * mode=enforce：block 级 finding 阻止加载，其余默认只记录；可通过 rules 单独
 *   指定 off/record/notify/block。
 * 误报放行：data/security/allowlist.json，按 plugin + ruleId + fileHash 精确匹配。
 * 后门/远程代码/核心篡改类规则不允许关闭或放行。
 */

const ACTIONS = new Set(["off", "record", "notify", "block"])
// 原生比较：插件改写 Set.prototype.has 也不影响审计处置
const nativeSetHas = Function.call.bind(Set.prototype.has)
const nativeIsArray = Array.isArray
const nativeString = String
const readFileSync = fs.readFileSync.bind(fs)
const parseJson = JSON.parse
// 这些规则即使 allowlist 也不能放行
const NEVER_ALLOW = new Set([
  "auth.known-backdoor",
  "auth.hash-compare",
  "auth.hash-variable",
  "auth.deserialize-hidden",
  "auth.decoded-id",
  "auth.decoded-authorization",
  "auth.hidden-file",
  "exfil.sensitive-read",
  "exec.inline-data-module",
  "exec.remote-static-import",
  "exec.remote-import",
  "exec.download-execute",
  "exec.destructive-command",
  "tamper.core-path",
  "tamper.disable-guard",
  "binary.native-load",
  "binary.script-danger",
  "audit.error",
])
// 观察模式也不降级的确定性风险；允许按文件哈希做误报放行
const FORCE_BLOCK = new Set([
  ...NEVER_ALLOW,
  "auth.fixed-id",
  "auth.fixed-id-list",
  "tamper.builtin-patch",
])
const ALLOWLIST_FILE = path.resolve("data/security/allowlist.json")
let allowCache = { at: 0, items: [] }

function readConf() {
  try {
    const { def, user } = readSecurityConfig()
    const a = { ...(def.pluginAudit || {}), ...(user.pluginAudit || {}) }
    const rules = { ...(def.pluginAudit?.rules || {}), ...(user.pluginAudit?.rules || {}) }
    return { mode: a.mode === "enforce" ? "enforce" : "observe", rules }
  } catch {
    return { mode: "observe", rules: {} }
  }
}

function allowlist() {
  if (Date.now() - allowCache.at < 2000) return allowCache.items
  let items = []
  try {
    const parsed = parseJson(readFileSync(ALLOWLIST_FILE, "utf8"))
    const raw = nativeIsArray(parsed) ? parsed : nativeIsArray(parsed?.items) ? parsed.items : []
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i]
      if (item && item.findingKey) items[items.length] = item
    }
  } catch {}
  allowCache = { at: Date.now(), items }
  return allowCache.items
}

function isAllowlisted(finding) {
  const key = makeFindingKey(finding)
  const items = allowlist()
  for (let i = 0; i < items.length; i++) {
    if (nativeString(items[i].findingKey) === key) return true
  }
  return false
}

function isNeverAllow(finding) {
  return finding.level === "block" && nativeSetHas(NEVER_ALLOW, finding.ruleId)
}

function isForceBlock(finding) {
  return finding.level === "block" && nativeSetHas(FORCE_BLOCK, finding.ruleId)
}

/** 只读判定：不导出可变集合，防止插件 clear()/add() 改写处置策略 */
export function isNeverAllowRule(ruleId) {
  return nativeSetHas(NEVER_ALLOW, ruleId)
}

/**
 * @returns {{action:"off"|"record"|"notify"|"block", notify:boolean, reason:string}}
 */
export function decideFinding(finding) {
  const conf = readConf()
  const rule = String(finding.ruleId || "")
  const override = ACTIONS.has(conf.rules[rule]) ? conf.rules[rule] : ""

  // 后门/远程代码/核心篡改/审计异常：任何模式都必须拦截，不允许放行
  if (isNeverAllow(finding)) return { action: "block", notify: true, reason: "never-allow" }
  // 精确文件哈希的误报放行；文件一变就失效
  if (isAllowlisted(finding)) return { action: "off", notify: false, reason: "allowlist" }

  // 正常/无问题的 finding 直接丢弃，不写审计、不发提示
  if (finding.level === "silent") return { action: "off", notify: false, reason: "silent" }

  // 单条规则显式覆盖；方便误报时只关闭/降级某一条，不必切全局模式
  if (override === "off") return { action: "off", notify: false, reason: "rule-off" }
  if (override === "record") return { action: "record", notify: false, reason: "rule-record" }
  if (override === "notify") return { action: "notify", notify: true, reason: "rule-notify" }
  if (override === "block") return { action: "block", notify: true, reason: "rule-block" }

  // 固定身份授权、隐藏主人、核心篡改：观察模式也直接拦截
  if (isForceBlock(finding)) return { action: "block", notify: true, reason: "force-block" }

  // 其余 block 级在 enforce 下拦截；observe 下作为“不确定/需提示”处理
  if (conf.mode === "enforce" && finding.level === "block") {
    return { action: "block", notify: true, reason: "enforce" }
  }
  if (finding.level === "block") return { action: "notify", notify: true, reason: "observe-block-review" }
  return { action: "notify", notify: true, reason: "notify" }
}

export { ALLOWLIST_FILE }
