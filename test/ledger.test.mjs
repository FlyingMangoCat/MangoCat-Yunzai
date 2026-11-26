import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import { findEntry, parseLedger } from "../lib/panel/ledger.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const source = readFileSync(path.join(root, "lib/panel/ledger.js"), "utf8")
const cacheFile = path.resolve("data/panel/ledger.json")

async function ledgerFixture({ def = {}, user = {}, files = {}, fetchImpl } = {}) {
  const disk = new Map(Object.entries(files))
  const writes = []
  let now = 1_000_000
  const fs = {
    existsSync: file => disk.has(file),
    readFileSync: file => {
      if (!disk.has(file)) throw new Error("missing")
      return disk.get(file)
    },
    mkdirSync() {},
    writeFileSync(file, text) {
      writes.push({ file, text })
      disk.set(file, text)
    },
  }
  const fetchCalls = []
  const fetch = async (...args) => {
    fetchCalls.push(args)
    return fetchImpl(...args)
  }
  const cfg = {
    getdefSet: () => ({ panel: def.panel || {} }),
    getConfig: () => ({ panel: user.panel || {} }),
  }
  const context = vm.createContext({
    Buffer,
    URL,
    Date: class extends Date {
      static now() { return now }
    },
  })
  const imports = {
    "node:fs": { default: fs },
    "node:path": { default: path },
    "node-fetch": { default: fetch },
    "../config/config.js": { default: cfg },
  }
  const module = new vm.SourceTextModule(source, { context, identifier: path.join(root, "lib/panel/ledger.js") })
  await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `unmocked import: ${specifier}`)
    const exports = imports[specifier]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  return { api: module.namespace, disk, writes, fetchCalls, setNow: value => { now = value } }
}

const table = `
| 等级 | 层 | 插件 | 作者 | 简介 | 类型 | 下载 | 检查 | 哈希 | 备注 | Star (2026-11-26) | 最后提交 | 首提交 | 修正标签 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 🟢 官方 | 2 | [Demo](https://github.com/acme/demo) (demo-dir) | [Alice](https://github.com/alice) | **说明** | 工具 | [主](https://gitee.com/acme/demo) / [镜像](https://gitcode.com/acme/demo) | 2026-11-25 | \`abcdef0\` | 正常 | GitHub 1593 / Gitee 65 / GitCode 8 | 2026-11-24T10:00:00Z | 2025-01-02 | 过时依赖 |
| ⚫ 已失效 | | Retired (retired-dir) | Bob | 旧插件 | 其它 | [仓库](https://gitee.com/acme/retired) | — | — | | — | | | — |
| 🟡 已收录 | 3 | [Other](https://gitcode.com/acme/demo) (other-dir) | Carol | 集合仓 | 工具 | [仓库](https://gitcode.com/acme/demo) | 2026-11-20 | 1234567 | 同仓库 | GitHub 1593 / Gitee 65 / GitCode 8 | 2026-11-19 | 2024-02-03 | 不兼容 |
`

test("ledger parser normalizes tiers, layers, platforms, stars, dates and repository collections", () => {
  const rows = parseLedger(table)
  assert.equal(rows.length, 3)
  const demo = rows[0]
  assert.equal(demo.tier, "official")
  assert.equal(demo.layer, "L2")
  assert.equal(demo.name, "Demo")
  assert.equal(demo.dir, "demo-dir")
  assert.equal(demo.platform, "github")
  assert.deepEqual(demo.stars, { github: 1593, gitee: 65, gitcode: 8 })
  assert.equal(demo.star, 1593)
  assert.equal(demo.repoKey, "github:acme/demo")
  assert.deepEqual(demo.downloads, ["https://gitee.com/acme/demo", "https://gitcode.com/acme/demo"])
  assert.equal(demo.hash, "abcdef0")
  assert.equal(demo.desc, "说明")
  assert.equal(demo.lastCommit, "2026-11-24")
  assert.equal(demo.firstCommit, "2025-01-02")
  assert.equal(demo.penalties, "过时依赖")
  assert.equal(demo.starSnapshot, "2026-11-26")
  assert.equal(rows[1].tier, "retired")
  assert.equal(rows[1].layer, "L0")
  assert.equal(rows[1].hash, "")
  assert.equal(rows[2].collection, 1)
})

test("legacy star values and proxy repository URLs remain compatible", () => {
  const rows = parseLedger(`
| 等级 | 插件 | 简介 | 类型 | 下载 | Star |
| --- | --- | --- | --- | --- | --- |
| 官方 | [Demo](https://gh-proxy.com/https://github.com/acme/demo) | | | [下载](https://gh-proxy.com/https://github.com/acme/demo) | 42 |
`)
  assert.equal(rows[0].star, 42)
  assert.equal(rows[0].platform, "github")
  assert.equal(rows[0].repoKey, "github:acme/demo")
  assert.equal(rows[0].collection, 1)
  assert.equal(rows[0].note, "")
})

test("legacy tables without a note column do not mistake the hash for notes", () => {
  const rows = parseLedger(`
| 等级 | 插件 | 作者 | 简介 | 类型 | 下载 | 检查 | 哈希 | Star |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 官方 | [Demo](https://github.com/acme/demo) | Alice | 正常说明 | 工具 | [下载](https://github.com/acme/demo) | 2026-11-25 | abcdef0 | 12 |
`)
  assert.equal(rows[0].note, "正常说明")
  assert.equal(rows[0].hash, "abcdef0")
  assert.equal(rows[0].star, 12)
})

test("entry lookup is exact and directory matches take priority over names", () => {
  const items = [
    { dir: "adapter", name: "adapter" },
    { dir: "foo-adapter", name: "foo" },
    { dir: "other", name: "target" },
    { dir: "target-dir", name: "target" },
  ]
  assert.equal(findEntry(items, "foo"), items[1])
  assert.equal(findEntry(items, "FOO-ADAPTER"), items[1])
  assert.equal(findEntry(items, "target"), items[2])
  assert.equal(findEntry(items, "adap"), null)
  assert.equal(findEntry(items, ""), null)
})

test("panel configuration merges nested ledger and install settings", async () => {
  const fixture = await ledgerFixture({
    def: { panel: { install: { allow: true, domains: ["github.com"] }, ledger: { cacheMinutes: 30, layers: { demo: "L1" } } } },
    user: { panel: { install: { allow: false }, ledger: { cacheMinutes: 5 } } },
  })
  assert.equal(fixture.api.installConf().allow, false)
  assert.deepEqual(Array.from(fixture.api.installConf().domains), ["github.com"])
  assert.equal(fixture.api.panelConf().ledger.cacheMinutes, 5)
  assert.equal(fixture.api.panelConf().ledger.layers.demo, "L1")
})

test("local ledger wins, memory cache respects TTL and force reloads the source", async () => {
  const local = path.resolve("参考内容/local.md")
  const fixture = await ledgerFixture({
    def: { panel: { ledger: { localPath: local, cacheMinutes: 1, layers: { "demo-dir": "3" } } } },
    files: { [local]: table },
    fetchImpl: async () => { throw new Error("fetch must not run") },
  })
  const first = await fixture.api.getLedger()
  assert.equal(first.source, `local:${local}`)
  assert.equal(first.items.length, 3)
  assert.equal(first.items[0].layer, "L3")
  assert.equal(fixture.fetchCalls.length, 0)
  fixture.disk.set(local, table.replace("Demo", "Demo Updated"))
  fixture.setNow(first.at + 30_000)
  const cached = await fixture.api.getLedger()
  assert.equal(cached.items[0].name, "Demo")
  const forced = await fixture.api.getLedger(true)
  assert.equal(forced.items[0].name, "Demo Updated")
  assert.equal(fixture.writes.at(-1).file, cacheFile)
})

test("fresh disk cache avoids fetch and failed remote refresh falls back marked stale", async () => {
  const cached = { at: 950_000, source: "remote", text: table }
  const fixture = await ledgerFixture({
    def: { panel: { ledger: { url: "https://ledger.example/include.md", cacheMinutes: 1 } } },
    files: { [cacheFile]: JSON.stringify(cached) },
    fetchImpl: async () => ({ ok: false, status: 503 }),
  })
  const fresh = await fixture.api.getLedger()
  assert.equal(fresh.source, "cache")
  assert.equal(fresh.stale, false)
  assert.equal(fixture.fetchCalls.length, 0)
  fixture.setNow(2_000_000)
  const stale = await fixture.api.getLedger()
  assert.equal(stale.stale, true)
  assert.equal(stale.items.length, 3)
  assert.match(stale.error, /HTTP 503/)
  assert.equal(fixture.fetchCalls.length, 1)
})

test("remote ledger is decoded as UTF-8 and replaces the disk cache", async () => {
  const fixture = await ledgerFixture({
    def: { panel: { ledger: { url: "https://ledger.example/include.md" } } },
    fetchImpl: async () => ({
      ok: true,
      arrayBuffer: async () => Buffer.from(table.replace("Demo", "远端插件")),
    }),
  })
  const result = await fixture.api.getLedger()
  assert.equal(result.source, "remote")
  assert.equal(result.items[0].name, "远端插件")
  assert.equal(result.stale, false)
  const saved = JSON.parse(fixture.writes.at(-1).text)
  assert.equal(saved.source, "remote")
  assert.match(saved.text, /远端插件/)
})
