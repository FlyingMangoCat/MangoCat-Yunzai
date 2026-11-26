import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import { candidatesFromLedger, ensureRemoteUsable } from "../lib/tools/gitSource.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const ok = (stdout = "") => ({ error: null, stdout, stderr: "" })
const fail = (message = "failed") => ({ error: new Error(message), stdout: "", stderr: message })

function gitFixture({ current = "https://old.example/repo", currentError = null, healthy = false, setErrors = {}, probes = {} } = {}) {
  const calls = []
  const logs = []
  let origin = current
  const execFn = async args => {
    assert.ok(Array.isArray(args), "git arguments must not be assembled into a shell string")
    calls.push(args)
    const [flag, dir, command, ...rest] = args
    assert.equal(flag, "-C")
    assert.equal(dir, "plugins/demo")
    if (command === "remote" && rest[0] === "get-url") return currentError ? fail(currentError) : ok(origin)
    if (command === "remote" && rest[0] === "set-url") {
      const url = rest[2]
      if (setErrors[url]) return fail(setErrors[url])
      origin = url
      return ok()
    }
    if (command === "ls-remote") {
      assert.deepEqual(rest, ["origin", "HEAD"])
      if (origin === current && healthy) return ok("abc\tHEAD")
      return probes[origin] ? probes[origin] : fail("unreachable")
    }
    assert.fail(`unexpected git command: ${args.join(" ")}`)
  }
  return { execFn, calls, logs, origin: () => origin }
}

test("ledger candidates match directory or name case-insensitively and preserve download priority", () => {
  const items = [
    { dir: "Other", name: "other", downloads: ["https://b.example/repo"], homepage: "https://a.example/repo" },
    { dir: "Demo", name: "demo", downloads: ["https://d.example/repo", "https://mirror.example/repo"], homepage: "https://home.example/repo" },
  ]
  assert.deepEqual(candidatesFromLedger(items, "DEMO"), [
    "https://d.example/repo",
    "https://mirror.example/repo",
    "https://home.example/repo",
  ])
  assert.deepEqual(candidatesFromLedger(items, "other"), ["https://b.example/repo", "https://a.example/repo"])
  assert.deepEqual(candidatesFromLedger(items, ""), [])
  assert.deepEqual(candidatesFromLedger(items, "missing"), [])
})

test("a healthy origin is left untouched", async () => {
  const fixture = gitFixture({ healthy: true })
  const result = await ensureRemoteUsable({ dir: "plugins/demo", candidates: ["https://new.example/repo"], execFn: fixture.execFn })
  assert.deepEqual(result, { url: "https://old.example/repo", switched: false })
  assert.deepEqual(fixture.calls.map(args => args.slice(2)), [
    ["remote", "get-url", "origin"],
    ["ls-remote", "origin", "HEAD"],
  ])
})

test("a missing or unreadable origin is delegated to the existing update flow", async () => {
  for (const options of [{ current: "" }, { currentError: "not a git repository" }]) {
    const fixture = gitFixture(options)
    const result = await ensureRemoteUsable({ dir: "plugins/demo", candidates: ["https://new.example/repo"], execFn: fixture.execFn })
    assert.deepEqual(result, { url: "", switched: false })
    assert.equal(fixture.calls.length, 1)
  }
})

test("fallback probes only unique http(s) candidates and keeps the first usable source", async () => {
  const usable = "https://mirror.example/repo"
  const fixture = gitFixture({ probes: { [usable]: ok("abc\tHEAD") } })
  const result = await ensureRemoteUsable({
    dir: "plugins/demo",
    candidates: [
      "https://old.example/repo",
      "file:///tmp/repo",
      "ssh://git@example/repo",
      "https://bad.example/repo",
      "https://bad.example/repo/",
      usable,
      "https://later.example/repo",
    ],
    execFn: fixture.execFn,
    log: message => fixture.logs.push(message),
  })
  assert.deepEqual(result, { url: usable, switched: true })
  assert.equal(fixture.origin(), usable)
  assert.deepEqual(fixture.calls.filter(args => args[2] === "remote" && args[3] === "set-url").map(args => args[5]), [
    "https://bad.example/repo",
    usable,
  ])
  assert.ok(fixture.logs.some(message => message.includes("已换源")))
})

test("a failed remote set-url skips probing that candidate", async () => {
  const broken = "https://broken.example/repo"
  const usable = "https://mirror.example/repo"
  const fixture = gitFixture({ setErrors: { [broken]: "cannot update origin" }, probes: { [usable]: ok("abc\tHEAD") } })
  const result = await ensureRemoteUsable({
    dir: "plugins/demo",
    candidates: [broken, usable],
    execFn: fixture.execFn,
    log: message => fixture.logs.push(message),
  })
  assert.equal(result.switched, true)
  assert.equal(result.url, usable)
  assert.equal(fixture.calls.filter(args => args[2] === "ls-remote" && args[3] === "origin").length, 2)
  assert.ok(fixture.logs.includes(`候选源不可用：${broken}`))
})

test("all failed candidates restore the original origin before reporting failure", async () => {
  const fixture = gitFixture()
  await assert.rejects(
    ensureRemoteUsable({
      dir: "plugins/demo",
      candidates: ["https://one.example/repo", "https://two.example/repo"],
      execFn: fixture.execFn,
    }),
    /远端已失效.*已恢复原远端/,
  )
  assert.equal(fixture.origin(), "https://old.example/repo")
  assert.deepEqual(fixture.calls.at(-1), ["-C", "plugins/demo", "remote", "set-url", "origin", "https://old.example/repo"])
})

test("the default git runner uses execFile argv and disables credential prompts", async () => {
  const source = readFileSync(path.join(root, "lib/tools/gitSource.js"), "utf8")
  const calls = []
  const replies = [
    ok("https://old.example/repo"),
    fail("unreachable"),
    ok(),
    ok("abc\tHEAD"),
  ]
  const context = vm.createContext({ process: { env: { PATH: "/usr/bin" } } })
  const module = new vm.SourceTextModule(source, { context, identifier: path.join(root, "lib/tools/gitSource.js") })
  await module.link(specifier => {
    assert.equal(specifier, "node:child_process")
    return new vm.SyntheticModule(["execFile"], function () {
      this.setExport("execFile", (file, args, options, callback) => {
        calls.push({ file, args, options })
        const reply = replies.shift()
        callback(reply.error, reply.stdout, reply.stderr)
      })
    }, { context })
  })
  await module.evaluate()
  const result = await module.namespace.ensureRemoteUsable({
    dir: "plugins/demo",
    candidates: ["https://mirror.example/repo"],
  })
  assert.equal(result.switched, true)
  assert.equal(calls.length, 4)
  for (const call of calls) {
    assert.equal(call.file, "git")
    assert.ok(Array.isArray(call.args))
    assert.deepEqual(Array.from(call.args.slice(0, 2)), ["-C", "plugins/demo"])
    assert.equal(call.options.windowsHide, true)
    assert.equal(call.options.env.GIT_TERMINAL_PROMPT, "0")
  }
  assert.deepEqual(Array.from(calls[2].args), ["-C", "plugins/demo", "remote", "set-url", "origin", "https://mirror.example/repo"])
})

test("remote URLs and directory names remain single argv values", async () => {
  const hostile = 'https://example.invalid/repo";touch owned;#'
  let origin = "https://old.example/repo"
  const result = await ensureRemoteUsable({
    dir: 'plugins/demo";touch owned;#',
    candidates: [hostile],
    execFn: async args => {
      assert.equal(args[1], 'plugins/demo";touch owned;#')
      if (args[2] === "remote" && args[3] === "set-url") {
        assert.equal(args[5], hostile)
        origin = args[5]
        return ok()
      }
      if (args[2] === "remote" && args[3] === "get-url") return ok(origin)
      if (args[2] === "ls-remote") return origin === "https://old.example/repo" ? fail() : ok("abc\tHEAD")
      assert.fail("unexpected command")
    },
  })
  assert.deepEqual(result, { url: hostile, switched: true })
})
