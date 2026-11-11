import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import util from "node:util"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import lodash from "lodash"

const root = fileURLToPath(new URL("../", import.meta.url))
const read = file => fs.readFileSync(path.join(root, file), "utf8")

function pluginClass() {
  const source = read("lib/plugins/plugin.js").replace("export default class plugin", "class plugin")
  return vm.runInNewContext(`${source}\nplugin`, { setTimeout, clearTimeout })
}

function fixture(modules = {}, bot = {}, segment = {}) {
  const handlers = []
  const jobs = []
  const errors = []
  const delayed = []
  const watchers = []
  const imports = []
  const source = read("lib/plugins/loader.js")
    .replace(/^import .*\r?\n/gm, "")
    .replace(/\bimport\s*\(/g, "importPlugin(")
    .replace("export default new PluginsLoader();", "new PluginsLoader();")
  const logger = { debug() {}, info() {}, mark() {}, warn() {}, error: value => errors.push(value), red: value => value }
  const loader = vm.runInNewContext(source, {
    global: {}, plugin: pluginClass(), segment, Bot: bot, util, lodash, path,
    cfg: { isMasterQQ: id => id === "master", getGroup: () => ({ botAlias: [] }) },
    logger, Handler: { add: value => handlers.push(value), del() {} },
    fs: { existsSync: () => true },
    moment: () => ({ format: () => "1" }),
    common: { sleep: async () => {} },
    process: { argv: ["node", "fixture"], env: {} },
    schedule: { scheduleJob: (cron, run) => { const job = { cron, run }; jobs.push(job); return job } },
    setTimeout: callback => { delayed.push(callback); return delayed.length },
    clearTimeout() {},
    getCaller: () => "plugins/fixture/index.js",
    handleFinding() {},
    importPlugin: async specifier => { imports.push(specifier); return modules },
    chokidar: { watch: () => {
      const events = {}
      const watcher = { on(event, fn) { events[event] = fn; return this }, removeAllListeners() {}, events }
      watchers.push(watcher)
      return watcher
    } },
  })
  for (const key of ["delCount", "scanAllPlugins", "reportPluginSecurity", "sanitizePlugin", "packageTips", "watch"]) loader[key] = () => {}
  loader.auditRoot = () => false
  loader.getPlugins = () => [{ name: "fixture/index.js", path: "fixture" }]
  return { loader, handlers, jobs, errors, delayed, watchers, imports }
}

function event(message = []) {
  return { self_id: "bot", user_id: "user", message_type: "private", sender: { nickname: "fixture" }, message }
}

test("loader adds missing segment constructors without replacing existing ones", () => {
  const segment = { image: () => "native-image", at: () => "native-at" }
  fixture({}, {}, segment)
  const file = segment.file("a.bin", "b.bin")
  assert.equal(file.type, "file")
  assert.equal(file.file, "a.bin")
  assert.equal(file.name, "b.bin")
  assert.equal(segment.reply("m1").type, "reply")
  assert.equal(segment.reply("m1").id, "m1")
  assert.equal(segment.raw({ type: "keyboard" }).type, "raw")
  assert.equal(segment.raw({ type: "keyboard" }).data.type, "keyboard")
  assert.equal(segment.custom("small", { id: 1 }).type, "small")
  assert.equal(segment.custom("small", { id: 1 }).id, 1)
  assert.equal(segment.image(), "native-image")
  assert.equal(segment.at(), "native-at")
})

test("task arrays and object options survive the plugin constructor", () => {
  const Plugin = pluginClass()
  const task = [{ name: "one", cron: "* * * * *", fnc() {}, log: false }, { name: "two", cron: "* * * * *", fnc() {}, log: true }]
  const p = new Plugin({ task })
  assert.equal(p.task, task)
  assert.equal(new Plugin({ task: task[0] }).task.log, false)
  assert.equal(new Plugin({ task: task[1] }).task.name, "two")
  const { loader } = fixture()
  loader.collectTask(p.task)
  assert.equal(loader.task.length, 2)
})

test("context distinguishes platform, account and user/group scopes", () => {
  const Plugin = pluginClass()
  const make = (adapter_id, self_id) => Object.assign(new Plugin({ name: "fixture" }), {
    e: { adapter_id, self_id, user_id: 123, group_id: 123 },
  })
  const first = make("QQ", 1)
  const second = make("QQ", 2)
  const forum = make("forum", 1)
  first.setContext("next", false, 0)
  assert.ok(first.getContext("next"))
  assert.equal(second.getContext("next"), undefined)
  assert.equal(forum.getContext("next"), undefined)
  assert.equal(first.getContext("next", true), undefined)
  assert.equal(first.conKey(), make("QQ", "1").conKey())
  const overridden = make("QQ", 1)
  overridden.userId = 456
  assert.notEqual(overridden.conKey(), first.conKey())
  first.finish("next")
  assert.equal(first.getContext("next"), undefined)
})

test("context identifiers containing separators do not collide", () => {
  const Plugin = pluginClass()
  const a = Object.assign(new Plugin({ name: "a.b" }), { e: { adapter_id: "c", self_id: "d", user_id: "e" } })
  const b = Object.assign(new Plugin({ name: "a" }), { e: { adapter_id: "b.c", self_id: "d", user_id: "e" } })
  assert.notEqual(a.conKey(), b.conKey())
})

test("runInit waits and propagates return values and rejection", async () => {
  const { loader } = fixture()
  const gate = Promise.withResolvers()
  let settled = false
  const result = loader.runInit({ init: () => gate.promise }).then(value => { settled = true; return value })
  await Promise.resolve()
  const early = settled
  gate.resolve("return")
  assert.equal(await result, "return")
  assert.equal(early, false)
  const rejected = Promise.reject(new Error("init failure"))
  rejected.catch(() => {})
  await assert.rejects(loader.runInit({ init: () => rejected }), /init failure/)
  assert.equal(await loader.runInit({}), undefined)
})

test("startup waits before registering handlers, tasks and commands", async () => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  class App {
    name = "fixture"
    task = {}
    handler = [{ fn: "handle", key: "fixture" }]
    handle() {}
    async init() {
      entered.resolve()
      await release.promise
      this.task = { name: "initialized", cron: "* * * * *", fnc() {} }
    }
  }
  const state = fixture({ App })
  const loading = state.loader.load()
  await entered.promise
  const early = state.loader.priority.length + state.handlers.length + state.jobs.length
  release.resolve()
  await loading
  assert.equal(early, 0)
  assert.equal(state.loader.priority.length, 1)
  assert.equal(state.handlers.length, 1)
  assert.equal(state.jobs.length, 1)
})

test("startup skip registers neither commands, handlers nor tasks", async () => {
  class App {
    name = "skip"
    task = { name: "skip", cron: "* * * * *", fnc() {} }
    handler = [{ fn: "handle", key: "skip" }]
    handle() {}
    async init() { return "return" }
  }
  const state = fixture({ App })
  await state.loader.load()
  assert.equal(state.loader.priority.length, 0)
  assert.equal(state.handlers.length, 0)
  assert.equal(state.jobs.length, 0)
})

test("startup init failure is reported without registering a partial plugin", async () => {
  const rejected = Promise.reject(new Error("initialization failed"))
  rejected.catch(() => {})
  class App { name = "failed"; task = {}; init() { return rejected } }
  const state = fixture({ App })
  await state.loader.load()
  assert.equal(state.loader.priority.length, 0)
  assert.ok(state.errors.some(value => String(value).includes("initialization failed")))
})

test("static audit still prevents imports and initialization", async () => {
  let called = false
  class App { init() { called = true } }
  const state = fixture({ App })
  state.loader.auditRoot = () => true
  await state.loader.load()
  assert.equal(state.imports.length, 0)
  assert.equal(called, false)
})

test("new plugin files initialize once and schedule only their new tasks", async () => {
  let initialized = 0
  class App {
    name = "added"
    task = {}
    handler = [{ fn: "handle", key: "added" }]
    handle() {}
    async init() { initialized++; this.task = { name: "new", cron: "* * * * *", fnc() {} } }
  }
  const state = fixture({ App })
  state.loader.task.push({ name: "old", cron: "* * * * *", fnc() {} })
  state.loader.watchDir("fixture")
  state.delayed.shift()()
  await state.watchers[0].events.add("./plugins/fixture/added.js")
  await state.watchers[0].events.add("./plugins/fixture/added.js")
  assert.equal(initialized, 1)
  assert.equal(state.loader.priority.length, 1)
  assert.equal(state.handlers.length, 1)
  assert.equal(state.jobs.length, 1)
  assert.equal(state.loader.task.length, 2)
})

test("a newly added plugin can opt out before registration", async () => {
  class App { name = "skip"; task = {}; async init() { return "return" } }
  const state = fixture({ App })
  state.loader.watchDir("fixture")
  state.delayed.shift()()
  await state.watchers[0].events.add("./plugins/fixture/skip.js")
  assert.equal(state.loader.priority.length, 0)
  assert.equal(state.jobs.length, 0)
})

test("event dispatch preserves the account instance and fills only missing bot", async () => {
  const first = { uin: 1 }, second = { uin: 2 }
  const { loader } = fixture({}, { uin: 1, 1: first, 2: second })
  loader.checkBlack = () => false
  const e = { self_id: 2, bot: second }
  await loader.deal(e)
  assert.equal(e.bot, second)
  const missing = { self_id: 2 }
  await loader.deal(missing)
  assert.equal(missing.bot, second)
})

test("group authorization accepts normalized roles without icqq private data", () => {
  const { loader } = fixture()
  for (const member of [{ is_admin: true, is_owner: false }, { is_admin: false, is_owner: true }]) {
    const e = { isGroup: true, isMaster: false, member, reply() {} }
    assert.equal(loader.filtPermission(e, { permission: "admin" }), true)
    assert.equal(loader.filtPermission(e, { permission: "master" }), false)
    assert.equal(loader.filtPermission(e, { permission: "owner" }), member.is_owner)
  }
})

test("missing, normal and nonboolean roles cannot gain group authorization", () => {
  const { loader } = fixture()
  for (const member of [undefined, {}, { is_admin: false, is_owner: false }, { is_admin: "true", is_owner: false }]) {
    const e = { isGroup: true, member, reply() {} }
    assert.equal(loader.filtPermission(e, { permission: "admin" }), false)
    assert.equal(loader.filtPermission(e, { permission: "owner" }), false)
  }
  assert.equal(loader.filtPermission({ isMaster: true }, { permission: "master" }), true)
})

test("reply segments expose reply_id and a readable quoted message", async () => {
  const { loader } = fixture()
  const calls = []
  const e = event([{ type: "reply", id: "q1" }])
  e.friend = {
    getMsg: async id => {
      calls.push(id)
      return { message_id: id }
    },
  }
  loader.dealMsg(e)
  assert.equal(e.reply_id, "q1")
  assert.deepEqual(await e.getReply(), { message_id: "q1" })
  assert.deepEqual(calls, ["q1"])
})

test("reply_id is preserved even when the target cannot read quoted messages", () => {
  const { loader } = fixture()
  const e = event([{ type: "reply", id: "q2" }])
  e.friend = {}
  loader.dealMsg(e)
  assert.equal(e.reply_id, "q2")
  assert.equal(e.getReply, undefined)
})

test("JSON and XML text is normalized while reply helper APIs remain optional", () => {
  const { loader } = fixture()
  const e = event([{ type: "json", data: { app: "fixture" } }, { type: "xml", data: "<fixture/>" }])
  loader.dealMsg(e)
  assert.equal(e.msg, '{"app":"fixture"}<fixture/>')
  assert.equal(e.getReply, undefined)
})

test("game flags follow game without converting unrelated games on false", () => {
  const { loader } = fixture()
  const e = event([{ type: "text", text: "#绝区零角色" }])
  loader.dealMsg(e)
  assert.equal(e.game, "zzz")
  assert.equal(e.isSr, false)
  assert.equal(e.isGs, false)
  e.isSr = false
  e.isGs = false
  assert.equal(e.game, "zzz")
  e.game = "sr"
  assert.equal(e.isSr, true)
  e.isGs = true
  assert.equal(e.game, "gs")
  e.isGs = false
  assert.equal(e.game, "sr")
  e.isSr = false
  assert.equal(e.game, "gs")
})

test("star-rail prefixes and legacy initial flags remain supported", () => {
  const { loader } = fixture()
  const e = event([{ type: "text", text: "*角色" }])
  loader.dealMsg(e)
  assert.equal(e.game, "sr")
  assert.equal(e.msg, "#星铁角色")
  const legacy = { ...event(), isSr: true }
  loader.dealMsg(legacy)
  assert.equal(legacy.game, "sr")
  assert.equal(legacy.isSr, true)
})

test("game normalization does not weaken the configuration-backed master lock", () => {
  const { loader } = fixture()
  const e = event()
  loader.dealMsg(e)
  assert.equal(e.isMaster, false)
  assert.throws(() => { e.isMaster = true }, /安全拦截/)
  assert.equal(e.isMaster, false)
  assert.equal(Object.getOwnPropertyDescriptor(e, "isMaster").configurable, false)
})
