import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import {
  checkCmdString,
  checkPath,
  inspectScriptText,
  stripScriptComments,
} from "../lib/security/commandPatterns.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const source = fs.readFileSync(path.join(root, "lib/config/cmdGuard.js"), "utf8")
const methods = ["exec", "execSync", "execFile", "execFileSync", "spawnSync", "spawn", "fork"]

async function fixture({ enabled = true, scripts = {}, caller = "plugins/demo/apps/main.js", inheritedEnv = {} } = {}) {
  const calls = []
  const findings = []
  const notices = []
  const logs = []
  const childProcess = {}
  const originals = {}

  for (const method of methods) {
    originals[method] = function (...args) {
      calls.push({ method, args })
      if (method === "execSync" && String(args[0]).startsWith("command -v ")) {
        return `/usr/bin/${String(args[0]).split(/\s+/).at(-1)}\n`
      }
      const callback = args.findLast(value => typeof value === "function")
      if (callback) callback(null, "ok", "")
      if (method === "spawn") return { pid: 1 }
      return { status: 0, stdout: "ok", stderr: "" }
    }
    childProcess[method] = originals[method]
  }

  const util = {
    exec(...args) {
      calls.push({ method: "Bot.exec", args })
      return Promise.resolve({ stdout: "ok", stderr: "", raw: {} })
    },
  }
  const context = vm.createContext({
    Buffer,
    process: { platform: process.platform, env: { PATH: "/usr/bin", ...inheritedEnv } },
    logger: {
      info: value => logs.push(value),
      warn: value => logs.push(value),
      error: value => logs.push(value),
      mark: value => logs.push(value),
    },
  })
  context.global = context

  const imports = {
    "node:child_process": { default: childProcess },
    "node:path": { default: path },
    "node:fs": { default: {
      readFileSync(file) {
        if (Object.hasOwn(scripts, file)) return scripts[file]
        throw new Error(`missing fixture script: ${file}`)
      },
    } },
    "./config.js": { default: { getOther: () => ({ cmdGuard: enabled }) } },
    "../util.js": { default: util },
    "node:module": { syncBuiltinESMExports() {} },
    "./guardCore.js": {
      getCaller: () => caller,
      notifyMaster: message => notices.push(message),
    },
    "../security/findingLog.js": { handleFinding: finding => findings.push(finding) },
    "../security/commandPatterns.js": {
      checkCmdString,
      checkPath,
      inspectScriptText,
      stripScriptComments,
    },
  }
  const module = new vm.SourceTextModule(source, {
    context,
    identifier: path.join(root, "lib/config/cmdGuard.js"),
  })
  await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `Unmocked import: ${specifier}`)
    const exports = imports[specifier]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  return { childProcess, originals, calls, findings, notices, logs, util }
}

function called(state, method) {
  return state.calls.filter(call => call.method === method)
}

test("disabled command guard leaves every child process entry point unchanged", async () => {
  const state = await fixture({ enabled: false })
  for (const method of methods) assert.equal(state.childProcess[method], state.originals[method])
  state.childProcess.execSync("rm -rf data")
  assert.equal(called(state, "execSync").length, 1)
  assert.deepEqual(state.findings, [])
})

test("dangerous execSync is blocked before the original process starts", async () => {
  const state = await fixture()
  assert.throws(() => state.childProcess.execSync("rm -rf data"), /已阻止危险命令/)
  assert.equal(called(state, "execSync").length, 0)
  assert.equal(state.findings.length, 1)
  assert.equal(state.findings[0].ruleId, "cmd.dangerous")
  assert.equal(state.findings[0].level, "block")
})

test("async exec reports the block through its callback and does not execute", async () => {
  const state = await fixture()
  const error = await new Promise(resolve => state.childProcess.exec("rm -rf data", resolve))
  assert.match(error.message, /已阻止危险命令/)
  assert.equal(called(state, "exec").length, 0)
  assert.equal(state.findings.length, 1)
})

test("execFile and spawn argument arrays cannot hide a core deletion", async () => {
  const state = await fixture()
  assert.throws(() => state.childProcess.execFileSync("rm", ["-rf", "data"]), /已阻止危险命令/)
  const result = state.childProcess.spawnSync("rm", ["-rf", "data"])
  assert.match(result.error.message, /已阻止危险命令/)
  assert.equal(called(state, "execFileSync").length, 0)
  assert.equal(called(state, "spawnSync").length, 0)
  assert.equal(state.findings.length, 2)
})

test("spawn and fork are blocked synchronously for dangerous command strings", async () => {
  const state = await fixture()
  assert.throws(() => state.childProcess.spawn("rm", ["-rf", "data"]), /已阻止危险命令/)
  assert.throws(() => state.childProcess.fork("rm", ["-rf", "data"]), /已阻止危险命令/)
  assert.equal(called(state, "spawn").length, 0)
  assert.equal(called(state, "fork").length, 0)
})

test("Bot.exec returns the standard error result for a blocked command", async () => {
  const state = await fixture()
  const result = await state.util.exec("rm -rf data")
  assert.match(result.error.message, /已阻止危险命令/)
  assert.equal(result.stdout, "")
  assert.equal(called(state, "Bot.exec").length, 0)
})

test("local shell scripts are inspected before silent execution", async () => {
  const harmful = await fixture({ scripts: { "plugins/demo/resources/bad.sh": "rm -rf data\n" } })
  assert.throws(() => harmful.childProcess.execSync("bash plugins/demo/resources/bad.sh"), /已阻止危险命令/)
  assert.equal(called(harmful, "execSync").length, 0)

  const harmless = await fixture({ scripts: { "plugins/demo/resources/ok.sh": "echo ok\n" } })
  harmless.childProcess.execSync("bash plugins/demo/resources/ok.sh")
  assert.equal(called(harmless, "execSync").length, 1)
  assert.deepEqual(harmless.notices, [])
})

test("trusted update and read commands stay silent", async () => {
  const state = await fixture()
  state.childProcess.execSync("git pull --ff-only")
  state.childProcess.execSync('git commit -m "fix: a||b"')
  state.childProcess.execSync("git status --short")
  state.childProcess.execSync("pnpm -v")
  assert.equal(called(state, "execSync").length, 8)
  assert.deepEqual(state.notices, [])
})

test("git clone is silent only with an explicit target inside the caller plugin", async () => {
  const own = await fixture()
  own.childProcess.execSync("git clone https://example.invalid/repo.git plugins/demo/resources/repo")
  assert.deepEqual(own.notices, [])

  for (const command of [
    "git clone https://example.invalid/repo.git plugins/other/repo",
    "git clone https://example.invalid/repo.git plugins/demo-evil/repo",
    "git clone https://example.invalid/repo.git",
  ]) {
    const state = await fixture()
    state.childProcess.execSync(command)
    assert.equal(state.notices.length, 1, command)
  }
})

test("quoted transport helpers and chained updates are reported, dangerous chains are blocked", async () => {
  const transport = await fixture()
  transport.childProcess.execSync('git clone "ext::sh -c touch /tmp/pwned" plugins/demo/repo')
  assert.equal(called(transport, "execSync").length, 1)
  assert.equal(transport.notices.length, 1)

  const chained = await fixture()
  chained.childProcess.execSync("git pull --ff-only && echo changed")
  assert.equal(called(chained, "execSync").length, 1)
  assert.equal(chained.notices.length, 1)

  const dangerous = await fixture()
  assert.throws(() => dangerous.childProcess.execSync("git pull\nrm -rf data"), /已阻止危险命令/)
  assert.equal(called(dangerous, "execSync").length, 0)
  assert.ok(dangerous.findings.length > 0)
})

test("dangerous environment injection is reported even for a clean trusted command", async () => {
  const state = await fixture()
  state.childProcess.execSync("git pull", { env: { PATH: "/usr/bin", GIT_SSH_COMMAND: "ssh -o ProxyCommand=evil" } })
  state.childProcess.execSync("git pull", { env: { PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/evil.js" } })
  assert.equal(called(state, "execSync").length, 2)
  assert.equal(state.notices.length, 2)
  assert.match(state.notices[0], /GIT_SSH_COMMAND/)
  assert.match(state.notices[1], /NODE_OPTIONS/)
})

test("inherited environment values are not treated as plugin injection", async () => {
  const state = await fixture({ inheritedEnv: { NODE_OPTIONS: "--no-warnings" } })
  state.childProcess.execSync("git pull", { env: { PATH: "/usr/bin", NODE_OPTIONS: "--no-warnings" } })
  assert.equal(called(state, "execSync").length, 2)
  assert.deepEqual(state.notices, [])
})

test("read-only git config is silent but config writes are reported", async () => {
  const state = await fixture()
  state.childProcess.execSync("git config --get core.hooksPath")
  assert.deepEqual(state.notices, [])
  state.childProcess.execSync("git config core.hooksPath /tmp/evil")
  assert.equal(state.notices.length, 1)
})
