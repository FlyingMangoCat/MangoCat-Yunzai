import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test, { after, before } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { createHash } from "node:crypto"

function makeFindingKey(input = {}) {
  const parts = [input.plugin, input.ruleId, input.file, input.line, input.summary, input.evidence?.text || input.evidence?.original, input.fileHash].map(value => String(value || ""))
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const policyPath = path.join(repoRoot, "lib/security/auditPolicy.js")
const allowlistFile = path.resolve("data/security/allowlist.json")
const tempParent = path.join(repoRoot, "temp")
let suiteRoot

before(() => {
  fs.mkdirSync(tempParent, { recursive: true })
  suiteRoot = fs.mkdtempSync(path.join(tempParent, "audit-policy-regression-"))
})

after(() => {
  if (suiteRoot) fs.rmSync(suiteRoot, { recursive: true, force: true })
})

async function policyFixture({ def = {}, user = {}, allowlist = [], allowlistText, readSecurityConfig } = {}) {
  const caseRoot = fs.mkdtempSync(path.join(suiteRoot, "case-"))
  class FixtureSet extends Set {}
  class FixtureJSON {
    static parse(...args) { return JSON.parse(...args) }
    static stringify(...args) { return JSON.stringify(...args) }
  }
  const context = vm.createContext({
    Date, Set: FixtureSet, Object, String, JSON: FixtureJSON, Array, Function, Map, FixtureSet,
    process: { cwd: () => caseRoot },
  })
  const imports = {
    "node:fs": {
      default: {
        readFileSync(file) {
          assert.equal(file, allowlistFile)
          if (allowlistText !== undefined) return allowlistText
          return JSON.stringify(allowlist)
        },
      },
    },
    "node:path": { default: path },
    "./securityConfig.js": {
      readSecurityConfig: () => {
        if (readSecurityConfig) return readSecurityConfig()
        const audit = value => value?.pluginAudit || value
        return { def: { pluginAudit: audit(def) }, user: { pluginAudit: audit(user) } }
      },
    },
    "./findingLog.js": { makeFindingKey },
  }
  const module = new vm.SourceTextModule(fs.readFileSync(policyPath, "utf8"), { context, identifier: policyPath })
  await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `unmocked import: ${specifier}`)
    const exports = imports[specifier]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context })
  })
  await module.evaluate()
  return module.namespace
}

const decisionOf = decision => ({ ...decision })

function finding(ruleId, level = "block", extra = {}) {
  return {
    plugin: "plugins/demo",
    ruleId,
    level,
    category: "fixture",
    file: "index.js",
    line: 7,
    fileHash: "a".repeat(64),
    summary: "fixture finding",
    operation: "fixture operation",
    evidence: { mode: "plain", text: "fixture evidence" },
    ...extra,
  }
}

function assertDecision(policy, input, expected) {
  assert.deepEqual(decisionOf(policy.decideFinding(input)), expected)
}

test("NEVER rules cannot be downgraded by mode, rule override or exact allowlist", async () => {
  const target = finding("auth.known-backdoor")
  const remoteTarget = finding("exec.remote-shell")
  const policy = await policyFixture({
    user: {
      pluginAudit: {
        mode: "observe",
        rules: {
          "auth.known-backdoor": "off",
          "exec.remote-shell": "record",
          "tamper.core-path": "notify",
          "audit.error": "off",
        },
      },
    },
    allowlist: [
      { findingKey: makeFindingKey(target) },
      { findingKey: makeFindingKey(remoteTarget) },
    ],
  })
  for (const ruleId of ["auth.known-backdoor", "audit.error", "tamper.core-path", "exec.download-execute", "exec.remote-shell"]) {
    assertDecision(policy, finding(ruleId), { action: "block", notify: true, reason: "never-allow" })
  }
  assertDecision(policy, remoteTarget, { action: "block", notify: true, reason: "never-allow" })
})

test("silent findings stay off even when their rule explicitly says block", async () => {
  const policy = await policyFixture({ user: { pluginAudit: { mode: "enforce", rules: { "fixture.silent": "block" } } } })
  assertDecision(policy, finding("fixture.silent", "silent"), { action: "off", notify: false, reason: "silent" })
})

test("observe/enforce and rule action matrix is deterministic", async () => {
  const actions = ["off", "record", "notify", "block", "invalid"]
  for (const mode of ["observe", "enforce", "invalid"]) {
    const rules = Object.fromEntries(actions.map(action => [`fixture.${action}`, action]))
    const policy = await policyFixture({ user: { pluginAudit: { mode, rules } } })
    for (const level of ["notify", "block"]) {
      for (const action of actions) {
        const expected = {
          off: { action: "off", notify: false, reason: "rule-off" },
          record: { action: "record", notify: false, reason: "rule-record" },
          notify: { action: "notify", notify: true, reason: "rule-notify" },
          block: { action: "block", notify: true, reason: "rule-block" },
          invalid:
            level === "block" && mode === "enforce"
              ? { action: "block", notify: true, reason: "enforce" }
              : level === "block"
                ? { action: "notify", notify: true, reason: "observe-block-review" }
                : { action: "notify", notify: true, reason: "notify" },
        }[action]
        assertDecision(policy, finding(`fixture.${action}`, level), expected)
      }
    }
  }
})

test("FORCE_BLOCK rules survive observe while downgradable block rules are reviewed", async () => {
  const policy = await policyFixture({ user: { pluginAudit: { mode: "observe" } } })
  for (const ruleId of ["auth.fixed-id", "auth.fixed-id-list", "tamper.builtin-patch"]) {
    assertDecision(policy, finding(ruleId), { action: "block", notify: true, reason: "force-block" })
  }
  assertDecision(policy, finding("exec.child-process"), { action: "notify", notify: true, reason: "observe-block-review" })
  assertDecision(policy, finding("exec.child-process", "notify"), { action: "notify", notify: true, reason: "notify" })
})

test("an allowlist is exact and a changed fileHash immediately invalidates it", async () => {
  const original = finding("fixture.allow")
  const policy = await policyFixture({ allowlist: [{ findingKey: makeFindingKey(original) }] })
  assertDecision(policy, original, { action: "off", notify: false, reason: "allowlist" })
  for (const changed of [
    { fileHash: "b".repeat(64) },
    { file: "other.js" },
    { line: 8 },
    { plugin: "other" },
  ]) assertDecision(policy, { ...original, ...changed }, { action: "notify", notify: true, reason: "observe-block-review" })
})

test("malformed, throwing and structurally invalid allowlists fail closed to review", async () => {
  for (const options of [
    { allowlistText: "{" },
    { allowlist: { items: [{ findingKey: "anything" }] } },
    { allowlist: [null, {}, { findingKey: 42 }] },
  ]) {
    const policy = await policyFixture(options)
    assertDecision(policy, finding("fixture.allow"), { action: "notify", notify: true, reason: "observe-block-review" })
  }
  const policy = await policyFixture({ readSecurityConfig() { throw new Error("hostile getter") } })
  assertDecision(policy, finding("fixture.allow"), { action: "notify", notify: true, reason: "observe-block-review" })
})

test("policy configuration merge honors default mode and user rules", async () => {
  const defaultPolicy = await policyFixture({ def: { mode: "enforce", rules: { "fixture.default": "block" } } })
  assertDecision(defaultPolicy, finding("fixture.default"), { action: "block", notify: true, reason: "rule-block" })
  assertDecision(defaultPolicy, finding("fixture.block"), { action: "block", notify: true, reason: "enforce" })

  const userPolicy = await policyFixture({
    def: { mode: "enforce", rules: { "fixture.merged": "block" } },
    user: { mode: "observe", rules: { "fixture.merged": "record", "fixture.user": "notify" } },
  })
  assert.equal(userPolicy.decideFinding(finding("fixture.merged")).action, "record")
  assert.equal(userPolicy.decideFinding(finding("fixture.block")).action, "notify")
  assert.equal(userPolicy.decideFinding(finding("fixture.user")).action, "notify")
})
