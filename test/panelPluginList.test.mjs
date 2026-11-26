import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const pluginsUrl = pathToFileURL(path.join(root, "lib/panel/plugins.js")).href
const tempRoot = path.join(root, "temp")

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function makeRepo(cwd, name, messages = ["initial"]) {
  const dir = path.join(cwd, "plugins", name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "index.js"), "export default {}\n")
  git(dir, "init", "--quiet")
  git(dir, "config", "user.name", "Regression Test")
  git(dir, "config", "user.email", "regression@example.invalid")
  git(dir, "config", "core.autocrlf", "false")
  const hashes = []
  for (const [index, message] of messages.entries()) {
    fs.writeFileSync(path.join(dir, "value.txt"), `${index}\n`)
    git(dir, "add", ".")
    git(dir, "commit", "--quiet", "-m", message)
    hashes.push(git(dir, "rev-parse", "HEAD"))
  }
  return { dir, hashes }
}

function writeLedger(cwd, rows) {
  const lines = [
    "| 等级 | 层 | 插件 | 作者 | 简介 | 类型 | 下载 | 检查 | 哈希 | 备注 | Star |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(row => `| ${row.tier || "官方"} | ${row.layer || "L1"} | [${row.name}](${row.homepage}) (${row.dir}) | Test | 测试 | 工具 | [下载](${row.homepage}) | 2026-11-26 | ${row.hash ? `\`${row.hash}\`` : "—"} | 正常 | GitHub 1 / Gitee 2 |`),
  ]
  fs.writeFileSync(path.join(cwd, "ledger.md"), `${lines.join("\n")}\n`)
}

async function listFixture(rows, setup = () => {}) {
  fs.mkdirSync(tempRoot, { recursive: true })
  const cwd = fs.mkdtempSync(path.join(tempRoot, "panel-list-"))
  try {
    fs.mkdirSync(path.join(cwd, "config/default_config"), { recursive: true })
    fs.mkdirSync(path.join(cwd, "config/config"), { recursive: true })
    fs.writeFileSync(path.join(cwd, "config/default_config/panel.yaml"), `panel:\n  ledger:\n    localPath: ${JSON.stringify(path.join(cwd, "ledger.md"))}\n`)
    writeLedger(cwd, rows)
    await setup(cwd)
    const code = `
      import fs from "node:fs"
      import { listPlugins } from ${JSON.stringify(pluginsUrl)}
      const result = await listPlugins()
      fs.writeFileSync(1, JSON.stringify(result))
      process.exit(0)
    `
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd,
      encoding: "utf8",
      timeout: 30000,
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

const row = (name, hash = "") => ({ name, dir: name, hash, homepage: `https://github.com/acme/${name}` })

test("plugin list follows ledger order and marks only exact ledger directories installed", async () => {
  const result = await listFixture([row("second"), row("first")], cwd => {
    makeRepo(cwd, "first")
    makeRepo(cwd, "second")
    fs.writeFileSync(path.join(cwd, "plugins/second/plugin.yaml"), "isolation: process\n")
    makeRepo(cwd, "first-extra")
    makeRepo(cwd, "unlisted")
  })
  assert.deepEqual(result.items.map(item => item.name), ["second", "first", "first-extra", "unlisted"])
  assert.equal(result.catalog.find(item => item.dir === "first").installed, true)
  assert.equal(result.catalog.find(item => item.dir === "second").installed, true)
  assert.equal(result.catalog.some(item => item.dir === "first-extra"), false)
  assert.equal(result.items.find(item => item.name === "unlisted").tier, "unknown")
  assert.equal(result.items.find(item => item.name === "second").layer, "L3")
  assert.equal(result.catalog.find(item => item.dir === "first").platform, "github")
  assert.equal(result.catalog.find(item => item.dir === "first").star, 1)
})

test("matching and prefix hashes avoid remote direction probes", async () => {
  const result = await listFixture([row("demo", "PREFIX")], cwd => {
    const repo = makeRepo(cwd, "demo")
    fs.writeFileSync(path.join(cwd, "ledger.md"), fs.readFileSync(path.join(cwd, "ledger.md"), "utf8").replace("PREFIX", repo.hashes[0].slice(0, 7)))
  })
  assert.equal(result.items[0].hashState, "match")
  assert.equal(result.items[0].hashCount, undefined)
})

test("hash direction distinguishes local ahead commits", async () => {
  const result = await listFixture([row("demo")], cwd => {
    const repo = makeRepo(cwd, "demo", ["audited", "local change"])
    writeLedger(cwd, [row("demo", repo.hashes[0])])
  })
  assert.equal(result.items[0].hashState, "ahead")
  assert.equal(result.items[0].hashCount, 1)
})

test("hash direction distinguishes local behind commits", async () => {
  const result = await listFixture([row("demo")], cwd => {
    const repo = makeRepo(cwd, "demo", ["old", "new"])
    writeLedger(cwd, [row("demo", repo.hashes[1])])
    git(repo.dir, "reset", "--hard", repo.hashes[0])
  })
  assert.equal(result.items[0].hashState, "behind")
  assert.equal(result.items[0].hashCount, 1)
})

test("hash direction reports diverged when the audited object is unavailable", async () => {
  const result = await listFixture([row("demo")], cwd => {
    makeRepo(cwd, "demo", ["local"])
    const other = makeRepo(cwd, "other")
    writeLedger(cwd, [row("demo", other.hashes[0])])
  })
  assert.equal(result.items[0].hashState, "diverged")
  assert.equal(result.items[0].hashCount, null)
})

test("packed refs and non-git package metadata remain readable", async () => {
  const result = await listFixture([row("demo")], cwd => {
    const repo = makeRepo(cwd, "demo")
    writeLedger(cwd, [row("demo", repo.hashes[0])])
    git(repo.dir, "pack-refs", "--all", "--prune")
    fs.mkdirSync(path.join(cwd, "plugins/plain"), { recursive: true })
    fs.writeFileSync(path.join(cwd, "plugins/plain/package.json"), JSON.stringify({ version: "1.2.3", description: "plain" }))
  })
  assert.equal(result.items.find(item => item.name === "demo").hashState, "match")
  const plain = result.items.find(item => item.name === "plain")
  assert.equal(plain.version, "1.2.3")
  assert.equal(plain.hashState, "none")
  assert.ok(plain.lastCommit)
})
