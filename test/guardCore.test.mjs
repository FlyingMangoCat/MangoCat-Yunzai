import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test, { after, before } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const guardPath = path.join(repoRoot, "lib/config/guardCore.js")
const tempParent = path.join(repoRoot, "temp")
let suiteRoot
let templateRoot

before(() => {
  fs.mkdirSync(tempParent, { recursive: true })
  suiteRoot = fs.mkdtempSync(path.join(tempParent, "guardcore-regression-"))
  templateRoot = path.join(suiteRoot, "template")
  fs.mkdirSync(path.join(templateRoot, "lib/config"), { recursive: true })
  fs.mkdirSync(path.join(templateRoot, "lib"), { recursive: true })
  fs.mkdirSync(path.join(templateRoot, "plugins/demo/apps"), { recursive: true })
  fs.mkdirSync(path.join(templateRoot, "plugins/other"), { recursive: true })
  fs.writeFileSync(path.join(templateRoot, "package.json"), '{"type":"module"}\n')
  fs.copyFileSync(guardPath, path.join(templateRoot, "lib/config/guardCore.js"))
  fs.writeFileSync(path.join(templateRoot, "lib/config/config.js"), [
    'export default {',
    '  masterQQ: ["master"],',
    '  checkGroup(id) { return id === 1 },',
    '}',
    '',
  ].join("\n"))
  fs.writeFileSync(path.join(templateRoot, "lib/verified.js"), 'export const verified = true\n')
  fs.writeFileSync(path.join(templateRoot, "lib/changed.js"), 'export const value = "committed"\n')
  execFileSync("git", ["init", "--quiet", "--object-format=sha1"], { cwd: templateRoot })
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "."], { cwd: templateRoot })
  execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: templateRoot })
})

after(() => {
  if (suiteRoot) fs.rmSync(suiteRoot, { recursive: true, force: true })
})

function runProbe(body, { probeRel = "plugins/demo/apps/probe.js", prepare } = {}) {
  const caseRoot = fs.mkdtempSync(path.join(suiteRoot, "case-"))
  fs.cpSync(templateRoot, caseRoot, { recursive: true })
  const probePath = path.join(caseRoot, ...probeRel.split("/"))
  fs.mkdirSync(path.dirname(probePath), { recursive: true })
  prepare?.(caseRoot)
  let importPath = path.posix.relative(path.posix.dirname(probeRel), "lib/config/guardCore.js")
  if (!importPath.startsWith(".")) importPath = `./${importPath}`
  let configPath = path.posix.relative(path.posix.dirname(probeRel), "lib/config/config.js")
  if (!configPath.startsWith(".")) configPath = `./${configPath}`
  fs.writeFileSync(probePath, [
    'import assert from "node:assert/strict"',
    'import fs from "node:fs"',
    `import cfg from ${JSON.stringify(configPath)}`,
    `const guard = await import(${JSON.stringify(importPath)})`,
    body,
    '',
  ].join("\n"))
  const result = execFileSync(process.execPath, [probePath], {
    cwd: caseRoot,
    encoding: "utf8",
    timeout: 20000,
    stdio: ["ignore", "pipe", "pipe"],
  })
  return result
}

test("caller attribution distinguishes third-party plugins from bundled core plugins", () => {
  runProbe('assert.equal(guard.getCaller(), "plugins/demo/apps/probe.js")')
  runProbe('assert.equal(guard.getCaller(), "本体(plugins/other/probe.js)")', { probeRel: "plugins/other/probe.js" })
})

test("caller attribution survives Error replacement and prepareStackTrace tampering", () => {
  runProbe(`
    const OriginalError = Error
    OriginalError.prepareStackTrace = () => [
      "Error",
      "    at forged (${String(path.join(repoRoot, "lib/config/guardCore.js")).replace(/\\/g, "/")}:1:1)",
    ]
    global.Error = class ForgedError extends OriginalError {}
    assert.equal(guard.getCaller(), "plugins/demo/apps/probe.js")
    assert.ok(OriginalError.prepareStackTrace)
  `)
})

test("self verification accepts only an unchanged file present in HEAD", () => {
  runProbe(`
    assert.equal(guard.isVerifiedSelf("本体(lib/verified.js)"), true)
    assert.equal(guard.isVerifiedSelf("本体(lib/missing.js)"), false)
    assert.equal(guard.isVerifiedSelf("plugins/demo/apps/probe.js"), false)
  `)
  runProbe(`
    assert.equal(guard.isVerifiedSelf("本体(lib/changed.js)"), false)
  `, {
    prepare(caseRoot) {
      fs.appendFileSync(path.join(caseRoot, "lib/changed.js"), 'export const tampered = true\n')
    },
  })
})

test("broadcast respects group filtering and master notification uses the configured Bot", () => {
  runProbe(`
    const groups = []
    const masters = []
    global.Bot = {
      uins: ["bot"],
      getGroupList: () => [1, 2],
      sendGroupMsg: (id, message) => groups.push([id, message]),
      sendMasterMsg: message => masters.push(message),
    }
    global.setTimeout = callback => { callback(); return 1 }
    guard.broadcast("alarm")
    guard.notifyMaster("master-alarm")
    assert.deepEqual(groups, [[1, "alarm"]])
    assert.deepEqual(masters, ["master-alarm"])
    cfg.masterQQ = []
    guard.notifyMaster("ignored")
    assert.deepEqual(masters, ["master-alarm"])
  `)
})

test("notifications queued before Bot readiness are flushed once after connection", () => {
  runProbe(`
    let flush
    global.setInterval = callback => { flush = callback; return 1 }
    global.clearInterval = () => {}
    guard.notifyMaster("queued-master")
    guard.broadcast("queued-group")
    const groups = []
    const masters = []
    global.Bot = {
      uins: ["bot"],
      getGroupList: () => [1, 2],
      sendGroupMsg: (id, message) => groups.push([id, message]),
      sendMasterMsg: message => masters.push(message),
    }
    global.setTimeout = callback => { callback(); return 1 }
    assert.equal(typeof flush, "function")
    flush()
    assert.deepEqual(groups, [[1, "queued-group"]])
    assert.deepEqual(masters, ["queued-master"])
    flush()
    assert.deepEqual(groups, [[1, "queued-group"]])
    assert.deepEqual(masters, ["queued-master"])
  `)
})
