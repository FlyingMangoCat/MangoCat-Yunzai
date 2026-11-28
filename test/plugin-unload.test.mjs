import test from "node:test"
import assert from "node:assert/strict"

/** 插件卸载资源回收自测：任务归档/取消、清理回调、同插件操作串行 */

global.logger = { error: () => {}, mark: () => {}, info: () => {}, warn: () => {}, debug: () => {} }
global.Bot = {
  adapter: [],
  uins: [],
  makeLog: () => {},
  em: () => {},
  redis: { get: async () => undefined, set: async () => {}, del: async () => {}, isReady: false },
}

const { default: loader } = await import("../lib/plugins/loader.js")

test("collectTask 按 key 归档任务", () => {
  loader.collectTask(
    [
      { cron: "0 0 * * *", name: "t1", fnc: () => {} },
      { cron: "0 1 * * *", name: "t2", fnc: () => {} },
    ],
    "test/a.js",
  )
  loader.collectTask({ cron: "0 2 * * *", name: "t3", fnc: () => {} }, "test/b.js")
  assert.equal(loader.task.length, 3)
  assert.deepEqual([...loader.taskMap.keys()].sort(), ["test/a.js", "test/b.js"])
})

test("removeTasks 只回收对应插件的任务并取消调度", () => {
  let cancelled = 0
  for (const val of loader.taskMap.get("test/a.js")) val.job = { cancel: () => cancelled++ }
  loader.removeTasks("test/a.js")
  assert.equal(cancelled, 2)
  assert.deepEqual(loader.task.map(t => t.name), ["t3"])
  assert.ok(!loader.taskMap.has("test/a.js"))
})

test("runUnload 执行清理回调并清空索引", async () => {
  let unloaded = 0
  loader.registerUnload("test/c.js", { name: "p1", unload: async () => { unloaded++ } })
  loader.registerUnload("test/c.js", { name: "p2" })
  assert.equal(loader.unloadMap.get("test/c.js").size, 1)
  await loader.runUnload("test/c.js")
  assert.equal(unloaded, 1)
  assert.ok(!loader.unloadMap.has("test/c.js"))
})

test("withPluginOp 同插件操作严格串行", async () => {
  const order = []
  const wait = ms => new Promise(r => setTimeout(r, ms))
  await Promise.all([
    loader.withPluginOp("k", async () => { await wait(30); order.push("first") }),
    loader.withPluginOp("k", async () => { order.push("second") }),
  ])
  assert.deepEqual(order, ["first", "second"])
  assert.ok(!loader.pluginOps.has("k"))
})
