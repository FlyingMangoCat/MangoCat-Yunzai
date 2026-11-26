import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test, { after, before } from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const logPath = path.join(repoRoot, "lib/security/findingLog.js")
const tempParent = path.join(repoRoot, "temp")
let suiteRoot

before(() => {
  fs.mkdirSync(tempParent, { recursive: true })
  suiteRoot = fs.mkdtempSync(path.join(tempParent, "finding-log-regression-"))
})

after(() => {
  if (suiteRoot) fs.rmSync(suiteRoot, { recursive: true, force: true })
})

async function logFixture({ append, failAppend = false, cwd = repoRoot, initialRecords = [] } = {}) {
  const caseRoot = fs.mkdtempSync(path.join(suiteRoot, "case-"))
  const file = path.join(caseRoot, "data/security/findings.jsonl")
  if (initialRecords.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, initialRecords.map(record => JSON.stringify(record)).join("\n") + "\n")
  }
  const notices = []
  const broadcasts = []
  const errors = []
  const context = vm.createContext({
    Buffer,
    Date: class FixtureDate extends Date {
      constructor(...args) { super(...(args.length ? args : [1700000000000])) }
      static now() { return 1700000000000 }
    },
    Set: class FixtureSet extends Set {},
    String,
    JSON,
    Array,
    Number,
    Object,
    Function,
    RegExp: class FixtureRegExp extends RegExp {},
    Error,
    process: { cwd: () => cwd, hrtime: process.hrtime },
    global: {
      logger: {
        error(...args) {
          errors.push(args)
        },
      },
    },
  })
  const imports = {
    "node:fs": {
      default: {
        readFileSync(target, ...args) { return fs.readFileSync(target === path.join(repoRoot, "data/security/findings.jsonl") ? file : target, ...args) },
        mkdirSync: fs.mkdirSync,
        appendFileSync(target, text, encoding) {
          const redirected = target === path.join(repoRoot, "data/security/findings.jsonl") ? file : target
          if (failAppend) throw new Error("fixture disk full")
          if (append) append(redirected, text, encoding)
          fs.mkdirSync(path.dirname(redirected), { recursive: true })
          return fs.appendFileSync(redirected, text, encoding)
        },
      },
    },
    "node:path": { default: path },
    "node:crypto": { default: (await import("node:crypto")).default },
    "../config/guardCore.js": {
      notifyMaster: message => notices.push(message),
      broadcast: message => broadcasts.push(message),
    },
  }
  const module = new vm.SourceTextModule(fs.readFileSync(logPath, "utf8"), { context, identifier: logPath })
  await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `unmocked import: ${specifier}`)
    const exports = imports[specifier]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context })
  })
  await module.evaluate()
  return { ...module.namespace, pure: {
    makeFindingKey: module.namespace.makeFindingKey,
    makeFindingId: module.namespace.makeFindingId,
    formatFinding: module.namespace.formatFinding,
  }, file, notices, broadcasts, errors }
}

function input(overrides = {}) {
  return {
    plugin: "plugins/demo",
    ruleId: "fixture.rule",
    level: "notify",
    category: "execution",
    file: "apps/main.js",
    line: 3,
    fileHash: "a".repeat(64),
    summary: "fixture summary",
    operation: "fixture operation",
    evidence: { mode: "plain", text: "fixture evidence" },
    action: "notify",
    ...overrides,
  }
}

const lines = file => fs.readFileSync(file, "utf8").trimEnd().split("\n").filter(Boolean).map(JSON.parse)

test("finding keys and IDs are stable and include all locating fields", async () => {
  const { pure } = await logFixture()
  const { makeFindingKey, makeFindingId, formatFinding } = pure
  const base = input()
  assert.equal(makeFindingKey(base), makeFindingKey({ ...base, action: "off" }))
  assert.equal(makeFindingId(base), makeFindingId({ ...base }))
  assert.notEqual(makeFindingId(base), makeFindingId({ ...base, action: "block" }))
  assert.match(makeFindingKey(base), /^[a-f0-9]{24}$/)
  for (const changed of [
    { plugin: "other" },
    { ruleId: "other.rule" },
    { file: "other.js" },
    { line: 4 },
    { summary: "other summary" },
    { evidence: { mode: "plain", text: "other evidence" } },
    { fileHash: "b".repeat(64) },
  ]) assert.notEqual(makeFindingKey(base), makeFindingKey({ ...base, ...changed }))
  assert.equal(makeFindingKey({ evidence: { text: "", original: "fallback" } }), makeFindingKey({ evidence: { original: "fallback" } }))
})

test("formatFinding is pure and renders actions/evidence without mutating records", async () => {
  const { pure: { formatFinding } } = await logFixture()
  for (const action of ["block", "notify", "record"]) {
    const record = { ...input({ action, evidence: { mode: "decoded", text: "decoded", method: "base64", hash: "abc", original: "payload" } }), id: "fixture-id" }
    const snapshot = JSON.stringify(record)
    const text = formatFinding(record)
    assert.equal(text, formatFinding(record))
    assert.equal(JSON.stringify(record), snapshot)
    assert.match(text, action === "block" ? /【安全拦截】/ : action === "notify" ? /【安全通报】/ : /【安全记录】/)
    assert.match(text, /解析结果：decoded/)
    assert.match(text, /来源方式：base64/)
    assert.match(text, /记录：/)
  }
  assert.match(formatFinding(input({ evidence: { mode: "raw", original: "raw evidence" } })), /原文（未解析）：raw evidence/)
})

test("duplicate IDs are suppressed while distinct evidence and repeated runtime events survive", async () => {
  const log = await logFixture()
  const base = input()
  const first = log.handleFinding(base, { notify: false })
  assert.ok(first)
  assert.equal(log.handleFinding(base, { notify: false }), null)
  assert.equal(lines(log.file).length, 1)

  const second = log.handleFinding({ ...base, evidence: { mode: "plain", text: "different evidence" } }, { notify: false })
  assert.ok(second)
  assert.notEqual(second.id, first.id)
  assert.equal(lines(log.file).length, 2)

  const repeatA = log.handleFinding(base, { repeat: true, notify: false })
  const repeatB = log.handleFinding(base, { repeat: true, notify: false })
  assert.ok(repeatA && repeatB)
  assert.notEqual(repeatA.id, repeatB.id)
  assert.equal(lines(log.file).length, 4)
})

test("records form a prev/hash chain and survive module reload", async () => {
  const log = await logFixture()
  const first = log.handleFinding(input(), { notify: false })
  const second = log.handleFinding(input({ line: 4 }), { notify: false })
  assert.equal(first.prev, "GENESIS")
  assert.equal(second.prev, first.hash)
  assert.equal(log.verifyFindingChain().ok, true)
  assert.equal(log.verifyFindingChain().count, 2)

  const reloaded = await logFixture({ initialRecords: [first, second] })
  assert.equal(reloaded.handleFinding(first, { notify: false }), null)
  const third = reloaded.handleFinding(input({ line: 5 }), { notify: false })
  assert.equal(third.prev, second.hash)
  assert.deepEqual({ ...reloaded.verifyFindingChain() }, { ok: true, count: 3, head: third.hash })
})

test("notifications are ID-deduplicated and group broadcast only applies to block actions", async () => {
  const log = await logFixture()
  const record = log.handleFinding(input({ level: "block", action: "block" }), { notify: true, group: true })
  assert.equal(log.notices.length, 1)
  assert.equal(log.broadcasts.length, 1)
  assert.match(log.notices[0], new RegExp(record.id))
  assert.equal(log.handleFinding(record, { notify: true, group: true }), null)
  assert.equal(log.notices.length, 1)
  assert.equal(log.broadcasts.length, 1)

  log.handleFinding(input({ level: "notify", action: "notify" }), { notify: true, group: true })
  assert.equal(log.notices.length, 2)
  assert.equal(log.broadcasts.length, 1)
})

test("append failure is not marked seen and the same finding can be retried", async () => {
  let fail = true
  let attempts = 0
  const log = await logFixture({
    append() {
      attempts++
      if (fail) throw new Error("fixture disk full")
    },
  })
  const failed = log.handleFinding(input(), { notify: false })
  assert.equal(failed, null)
  assert.equal(attempts, 1)
  assert.equal(log.errors.length, 1)
  assert.equal(fs.existsSync(log.file), false)

  fail = false
  const next = log.handleFinding(input(), { notify: false })
  assert.equal(attempts, 2)
  assert.ok(next)
  assert.equal(next.prev, "GENESIS")
  assert.equal(lines(log.file).length, 1)
  assert.equal(log.verifyFindingChain().ok, true)
})

function rewriteRecord(file, index, mutate) {
  const records = lines(file)
  mutate(records[index])
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n") + "\n")
}

test("chain verification detects record, half-line and whole-line tampering", async t => {
  await t.test("changing a recorded field invalidates its hash", async () => {
    const log = await logFixture()
    const first = log.handleFinding(input(), { notify: false })
    log.handleFinding(input({ line: 4 }), { notify: false })
    rewriteRecord(log.file, 0, record => { record.summary = "attacker summary" })
    assert.deepEqual({ ...log.verifyFindingChain() }, { ok: false, at: first.id, reason: "hash 不匹配" })
  })

  await t.test("replacing half a line with same-length text is detected", async () => {
    const log = await logFixture()
    const first = log.handleFinding(input(), { notify: false })
    const raw = fs.readFileSync(log.file, "utf8")
    const at = raw.indexOf("fixture summary")
    assert.ok(at >= 0)
    fs.writeFileSync(log.file, raw.slice(0, at) + "attacker summary" + raw.slice(at + "fixture summary".length))
    assert.deepEqual({ ...log.verifyFindingChain() }, { ok: false, at: first.id, reason: "hash 不匹配" })
  })

  await t.test("reordering or replacing a whole record breaks prev", async () => {
    const log = await logFixture()
    const first = log.handleFinding(input(), { notify: false })
    log.handleFinding(input({ line: 4 }), { notify: false })
    const records = lines(log.file)
    records.reverse()
    fs.writeFileSync(log.file, records.map(record => JSON.stringify(record)).join("\n") + "\n")
    const verified = log.verifyFindingChain()
    assert.equal(verified.ok, false)
    assert.equal(verified.at, records[0].id)
    assert.equal(verified.reason, "prev 不匹配")
  })

  await t.test("truncated or non-JSON lines fail verification diagnostically", async () => {
    const log = await logFixture()
    log.handleFinding(input(), { notify: false })
    fs.appendFileSync(log.file, '{"id":"truncated"')
    const verified = log.verifyFindingChain()
    assert.equal(verified.ok, false)
    assert.equal(typeof verified.reason, "string")
  })
})
