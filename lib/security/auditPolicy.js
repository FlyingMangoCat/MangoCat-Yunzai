import fs from "node:fs"
import path from "node:path"
import cfg from "../config/config.js"
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
  "audit.error",
])
// 观察模式也不降级的确定性风险；允许按文件哈希做误报放行
const FORCE_BLOCK = new Set([
  ...NEVER_ALLOW,
  "auth.fixed-id",
  "auth.fixed-id-list",
  "binary.file",
  "exec.git-argument",
  "exec.child-process",
  "fs.user-path",
  "obfuscation.detected",
  "obfuscation.hidden-filename",
])
const ALLOWLIST_FILE = path.resolve("data/security/allowlist.json")
let allowCache = { at: 0, items: [] }

function readConf() {
  try {
    const def = cfg.getYaml?.("default_config", "security") || {}
    const user = cfg.getConfig?.("security") || {}
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
    const parsed = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8"))
    items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
  } catch {}
  allowCache = { at: Date.now(), items: items.filter((i) => i && i.findingKey) }
  return allowCache.items
}

function isAllowlisted(finding) {
  const key = makeFindingKey(finding)
  return allowlist().some((i) => String(i.findingKey) === key)
}

function isNeverAllow(finding) {
  return finding.level === "block" && NEVER_ALLOW.has(finding.ruleId)
}

function isForceBlock(finding) {
  return finding.level === "block" && FORCE_BLOCK.has(finding.ruleId)
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

  // 单条规则显式覆盖；方便误报时只关闭/降级某一条，不必切全局模式
  if (override === "off") return { action: "off", notify: false, reason: "rule-off" }
  if (override === "record") return { action: "record", notify: false, reason: "rule-record" }
  if (override === "notify") return { action: "notify", notify: true, reason: "rule-notify" }
  if (override === "block") return { action: "block", notify: true, reason: "rule-block" }

  // 固定身份授权、二进制、危险 git/路径穿越：观察模式也拦截
  if (isForceBlock(finding)) return { action: "block", notify: true, reason: "force-block" }

  if (conf.mode === "enforce" && finding.level === "block") {
    return { action: "block", notify: true, reason: "enforce" }
  }
  return { action: "record", notify: false, reason: "observe" }
}

export { NEVER_ALLOW, ALLOWLIST_FILE }
