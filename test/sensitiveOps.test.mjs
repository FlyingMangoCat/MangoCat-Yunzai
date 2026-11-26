import assert from "node:assert/strict"
import http from "node:http"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"

function makeFindingKey(input = {}) {
  const parts = [input.plugin, input.ruleId, input.file, input.line, input.summary, input.evidence?.text || input.evidence?.original, input.fileHash].map(value => String(value || ""))
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const sensitivePath = path.join(repoRoot, "lib/security/sensitiveOps.js")
const loaderPath = path.join(repoRoot, "lib/plugins/loader.js")
const policyPath = path.join(repoRoot, "lib/security/auditPolicy.js")

const nativeClearTimeout = globalThis.clearTimeout

async function sensitiveFixture({ masters = [10001], trustWindow = 600, enable = true, clock } = {}) {
  const emitted = []
  const prompts = []
  const listeners = new Set()
  const context = vm.createContext({
    console,
    URL,
    setTimeout,
    clearTimeout(timer) {
      timer.cleared = true
      nativeClearTimeout(timer)
    },
    Date: clock ? class FixtureDate extends Date { static now() { return clock.value } } : Date,
    Number,
    String,
    JSON,
    Array,
    Promise,
    http: { Server: { prototype: { emit() { emitted.push([...arguments]); return true } } } },
    process: { cwd: () => repoRoot },
    global: {},
  })
  context.global.Bot = {
    sendMasterMsg: message => prompts.push(message),
    on(event, listener) {
      assert.equal(event, "message")
      listeners.add(listener)
    },
    off(event, listener) {
      assert.equal(event, "message")
      listeners.delete(listener)
    },
  }
  const imports = {
    "node:http": { default: context.http },
    "../config/config.js": { default: { isMasterQQ: id => masters.includes(Number(id)) } },
    "./securityConfig.js": {
      readSecurityConfig: () => ({
        def: { sensitiveOps: { enable, trustWindow } },
        user: { sensitiveOps: {} },
      }),
    },
  }
  const module = new vm.SourceTextModule(fsRead(sensitivePath), { context, identifier: sensitivePath })
  await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `unmocked import: ${specifier}`)
    const exports = imports[specifier]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context })
  })
  await module.evaluate()
  module.namespace.installSensitiveOps()
  return { ...module.namespace, emitted, prompts, listeners, context }
}

const response = () => {
  const state = { headers: undefined, body: undefined, ended: false }
  return {
    state,
    writeHead(status, headers) { state.headers = [status, headers] },
    end(body) { state.body = body; state.ended = true },
  }
}
const request = (url, method = "POST", source = "127.0.0.1") => ({ url, method, socket: { remoteAddress: source } })
const emit = (state, url, method, source) => {
  const res = response()
  const returned = state.context.http.Server.prototype.emit.call({}, "request", request(url, method, source), res)
  return { returned, res }
}
const deliver = (state, data) => {
  for (const listener of [...state.listeners]) listener(data)
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test("only the master's exact private 确认 resolves a pending confirmation", async () => {
  const state = await sensitiveFixture()
  let settled = false
  const pending = state.requestConfirm("安装插件", "fixture").then(value => { settled = true; return value })
  assert.equal(state.prompts.length, 1)
  assert.equal(state.listeners.size, 1)

  deliver(state, { message_type: "private", user_id: 10001, message: "确认操作" })
  deliver(state, { message_type: "private", user_id: 10001, message: "请确认" })
  deliver(state, { message_type: "group", user_id: 10001, message: "确认" })
  deliver(state, { message_type: "private", user_id: 99999, message: "确认" })
  await settle()
  assert.equal(settled, false)
  assert.equal(state.listeners.size, 1)

  deliver(state, { message_type: "private", user_id: 10001, message: "确认" })
  await settle()
  assert.equal(settled, true)
  assert.equal(await pending, true)
  assert.equal(state.listeners.size, 0)
  deliver(state, { message_type: "private", user_id: 10001, message: "确认" })
  assert.equal(await pending, true)
})

test("confirmation timeout rejects and removes its listener", async () => {
  const timers = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = timer => { timer.cleared = true }
  try {
    const state = await sensitiveFixture()
    const pending = state.requestConfirm("安装插件", "fixture")
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 120000)
    timers[0].callback()
    assert.equal(await pending, false)
    assert.equal(state.listeners.size, 0)
    assert.equal(timers[0].cleared, true)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})

test("missing Bot capabilities reject without throwing", async () => {
  const state = await sensitiveFixture()
  delete state.context.global.Bot.sendMasterMsg
  assert.equal(await state.requestConfirm("安装插件", "fixture"), false)
})

test("install gate matches case and one URI decode across HTTP methods", async () => {
  const state = await sensitiveFixture()
  const first = emit(state, "/API/PLUGIN/INSTALL?source=panel", "GET")
  assert.equal(first.returned, true)
  assert.equal(first.res.state.ended, false)
  const concurrent = emit(state, "/api/%50lugin/Install/extra", "POST")
  assert.equal(concurrent.res.state.ended, true)
  assert.match(concurrent.res.state.body, /已有待确认/)

  deliver(state, { message_type: "private", user_id: 10001, message: "确认" })
  await settle()
  assert.equal(state.emitted.length, 1)

  const trusted = emit(state, "/api/plugin/%75NINSTALL", "DELETE")
  assert.equal(trusted.res.state.ended, false)
  assert.equal(state.emitted.length, 2)
  assert.equal(state.prompts.length, 1)
})

test("plural panel plugin routes are gated before dispatch", async () => {
  for (const route of ["/api/plugins/install", "/api/plugins/uninstall"]) {
    const state = await sensitiveFixture()
    const first = emit(state, route, "POST")
    assert.equal(first.returned, true)
    assert.equal(first.res.state.ended, false)
    assert.equal(state.emitted.length, 0)
    assert.equal(state.prompts.length, 1)
    deliver(state, { message_type: "private", user_id: 10001, message: "确认" })
    await settle()
    assert.equal(state.emitted.length, 1)
  }
})

test("non-gated paths and non-request events pass through unchanged", async () => {
  const state = await sensitiveFixture()
  const ordinary = emit(state, "/api/plugin/list", "GET")
  assert.equal(ordinary.returned, true)
  assert.equal(ordinary.res.state.ended, false)
  assert.equal(state.emitted.length, 1)
  assert.equal(state.prompts.length, 0)

  state.context.http.Server.prototype.emit.call({}, "connection", {}, response())
  assert.equal(state.emitted.length, 2)
})

test("disabled configuration passes gated requests through without confirmation", async () => {
  const state = await sensitiveFixture({ enable: false })
  const result = emit(state, "/api/plugin/install")
  assert.equal(state.emitted.length, 1)
  assert.equal(result.res.state.ended, false)
  assert.equal(state.prompts.length, 0)
})

test("concurrent confirmations accept only the first waiter", async () => {
  const state = await sensitiveFixture()
  const first = state.requestConfirm("安装插件", "fixture")
  const second = state.requestConfirm("卸载插件", "fixture")
  assert.equal(await second, false)
  assert.equal(state.prompts.length, 1)
  assert.equal(state.listeners.size, 1)
  deliver(state, { message_type: "private", user_id: 10001, message: "确认" })
  await settle()
  assert.equal(await first, true)
  assert.equal(state.listeners.size, 0)
})

test("a gate exception rejects the sensitive request instead of dispatching it", async () => {
  const state = await sensitiveFixture()
  const res = response()
  const req = {
    url: "/api/plugin/install",
    get socket() { throw new Error("fixture socket failure") },
  }
  const returned = state.context.http.Server.prototype.emit.call({}, "request", req, res)
  assert.equal(returned, true)
  assert.equal(res.state.ended, true)
  assert.match(res.state.body, /未获得主人确认/)
  assert.equal(state.emitted.length, 0)
})

test("concurrent gated requests are rejected and rejection returns diagnosable JSON", async () => {
  const state = await sensitiveFixture()
  const first = emit(state, "/api/plugin/install")
  const second = emit(state, "/api/plugin/uninstall")
  assert.equal(first.res.state.ended, false)
  assert.equal(second.res.state.ended, true)
  assert.equal(second.res.state.headers[0], 200)
  assert.match(second.res.state.headers[1]["Content-Type"], /application\/json/)
  assert.equal(JSON.parse(second.res.state.body).status, 1)

  deliver(state, { message_type: "private", user_id: 99999, message: "确认" })
  await settle()
  assert.equal(state.emitted.length, 0)
  deliver(state, { message_type: "private", user_id: 10001, message: "确认" })
  await settle()
  assert.equal(state.emitted.length, 1)
})

test("trustWindow is source-bound and expires using wall-clock time", async () => {
  const clock = { value: 1000 }
  const state = await sensitiveFixture({ trustWindow: 2, clock })

  emit(state, "/api/plugin/install", "POST", "198.51.100.1")
  deliver(state, { message_type: "private", user_id: 10001, message: "确认" })
  await settle()
  assert.equal(state.emitted.length, 1)
  assert.equal(state.prompts.length, 1)

  clock.value = 2999
  emit(state, "/api/plugin/uninstall", "POST", "198.51.100.1")
  assert.equal(state.emitted.length, 2)
  assert.equal(state.prompts.length, 1)

  const otherSource = emit(state, "/api/plugin/install", "POST", "198.51.100.2")
  assert.equal(otherSource.res.state.ended, false)
  assert.equal(state.emitted.length, 2)
  assert.equal(state.prompts.length, 2)
  deliver(state, { message_type: "private", user_id: 10001, message: "确认" })
  await settle()
  assert.equal(state.emitted.length, 3)

  clock.value = 4999
  emit(state, "/api/plugin/install", "POST", "198.51.100.1")
  assert.equal(state.prompts.length, 3)
  assert.equal(state.emitted.length, 3)
  deliver(state, { message_type: "private", user_id: 10001, message: "确认" })
  await settle()
  assert.equal(state.emitted.length, 4)
})

test("real http.Server.prototype.emit patch is isolated and restored in a child process", () => {
  const probe = `
    import assert from 'node:assert/strict'
    import http from 'node:http'
    import { pathToFileURL } from 'node:url'
    const original = http.Server.prototype.emit
    const { installSensitiveOps } = await import(pathToFileURL(${JSON.stringify(sensitivePath)}))
    global.Bot = { sendMasterMsg() {}, on() {}, off() {} }
    installSensitiveOps()
    assert.notEqual(http.Server.prototype.emit, original)
    const fake = new http.Server()
    const req = { url: '/api/plugin/list', socket: { remoteAddress: '127.0.0.1' } }
    const res = { writeHead() { assert.fail('unexpected gate response') }, end() {} }
    assert.equal(fake.emit('request', req, res), false)
    http.Server.prototype.emit = original
    assert.equal(http.Server.prototype.emit, original)
  `
  execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
  })
  assert.equal(typeof http.Server.prototype.emit, "function")
})

async function loaderFixture() {
  const logs = []
  const findings = []
  const notices = []
  const imported = []
  const source = fsRead(loaderPath)
  const context = vm.createContext({
    console,
    URL,
    Map,
    Set,
    String,
    Object,
    Array,
    path,
    Date,
    Error,
    process: { cwd: () => repoRoot },
    global: { plugin: {} },
    segment: {},
    logger: Object.fromEntries(["info", "warn", "error", "mark", "debug", "red"].map(name => [name, value => logs.push(`${name}:${value}`)])),
  })
  context.global.segment = context.segment
  const imports = {
    "node:util": { default: {} },
    "node:fs": { default: {} },
    "lodash": { default: {
      isEmpty: value => !value || Object.keys(value).length === 0,
      orderBy: value => value,
    } },
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
    "node:child_process": { execSync() { assert.fail("unexpected cleanup commit") } },
    "../config/pluginScan.js": {
      detectBackdoor: () => null,
      sanitizeSource: source => ({ changed: false, source }),
      resolveBackdoorQQ: () => ({ qqs: [], hashes: [] }),
    },
    "../config/guardCore.js": {
      notifyMaster: message => notices.push(message),
      broadcast() {},
      getCaller: () => "fixture",
    },
    "../security/pluginAudit.js": {
      auditPlugin() {
        return { plugin: "demo", findings: [], blocked: false }
      },
    },
    "../security/auditPolicy.js": {
      decideFinding() {
        return { action: "notify", notify: true, reason: "fixture" }
      },
    },
    "../security/findingLog.js": {
      handleFinding(finding, options) {
        findings.push({ finding, options })
        return { ...finding, key: makeFindingKey(finding) }
      },
    },
  }
  const module = new vm.SourceTextModule(source, { context, identifier: loaderPath })
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
  return { loader, logs, findings, notices, imported }}

function fsRead(file) {
  return requireFs(file)
}
function requireFs(file) {
  return fsDefault.readFileSync(file, "utf8")
}
import fsDefault from "node:fs"

test("loader load gate never reaches sanitization/import when audit blocks", async () => {
  const result = await loaderFixture()
  const files = [{ name: "demo/index.js", path: "file:///temp/demo/index.js" }]
  result.loader.scanAllPlugins = () => {}
  result.loader.reportPluginSecurity = () => {}
  result.loader.getPlugins = () => files
  result.loader.delCount = () => {}
  result.loader.auditRoot = () => true
  result.loader.sanitizePlugin = () => { throw new Error("sanitizer should not run") }
  result.loader.creatTask = () => {}
  await result.loader.load()
  assert.ok(result.logs.some(line => line.includes("加载插件完成")))
})
