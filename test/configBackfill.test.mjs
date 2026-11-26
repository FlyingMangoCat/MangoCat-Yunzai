import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import vm from "node:vm"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const configSource = fs.readFileSync(path.join(root, "lib/config/config.js"), "utf8")

const EXISTING_USER = Buffer.from([
  "# preserve this header byte-for-byte",
  "existing:",
  "  keep: user-value",
  "  nested:",
  "    userOnly: true",
  "",
  "untouched: false",
  "",
].join("\n"), "utf8")

const DEFAULT_TEMPLATE = [
  "# new top-level section",
  "added:",
  "  keep: default-value",
  "  nested:",
  "    fromTemplate: true",
  "",
  "# another new section",
  "other:",
  "  enabled: true",
  "",
].join("\n")

async function loadCfg({ user = EXISTING_USER, template = DEFAULT_TEMPLATE, existing = true, renameFails = false } = {}) {
  const files = new Map()
  const calls = []
  const parsedTexts = []
  files.set("config/default_config/example.yaml", Buffer.from(template))
  if (existing) files.set("config/config/example.yaml", Buffer.from(user))

  const mockYaml = {
    parse(text) {
      parsedTexts.push(text)
      return YAML.parse(text)
    },
  }

  const mockFs = {
    existsSync(file) {
      calls.push(["existsSync", file])
      if (file === "config/config/" || file === "data" || file === "resources") return true
      return files.has(file)
    },
    mkdirSync(file, options) {
      calls.push(["mkdirSync", file, options])
      files.set(file, Buffer.alloc(0))
    },
    readdirSync(dir) {
      calls.push(["readdirSync", dir])
      assert.equal(dir, "config/default_config/")
      return ["example.yaml"]
    },
    readFileSync(file, encoding) {
      calls.push(["readFileSync", file, encoding])
      assert.equal(encoding, "utf8")
      if (!files.has(file)) throw new Error(`missing fixture file: ${file}`)
      return files.get(file).toString("utf8")
    },
    copyFileSync(source, target) {
      calls.push(["copyFileSync", source, target])
      files.set(target, Buffer.from(template))
    },
    writeFileSync(file, text) {
      calls.push(["writeFileSync", file, text])
      files.set(file, Buffer.from(text, "utf8"))
    },
    renameSync(source, target) {
      calls.push(["renameSync", source, target])
      if (renameFails) throw new Error("fixture rename failure")
      assert.ok(files.has(source), `rename source must exist: ${source}`)
      files.set(target, files.get(source))
      files.delete(source)
    },
  }

  const logs = []
  const context = vm.createContext({
    console: {
      log: (...args) => logs.push(args.join(" ")),
      warn: (...args) => logs.push(args.join(" ")),
    },
  })
  context.global = context

  const imports = {
    "node:fs": { default: mockFs },
    yaml: { default: mockYaml },
    chokidar: { default: { watch: () => assert.fail("configuration initialization must not start a watcher") } },
  }
  const module = new vm.SourceTextModule(configSource, {
    context,
    identifier: path.join(root, "lib/config/config.js"),
  })
  await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `unmocked import: ${specifier}`)
    const exports = imports[specifier]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context })
  })
  await module.evaluate()

  return {
    cfg: module.namespace.default,
    files,
    calls,
    logs,
    parsedTexts,
    userFile: () => files.get("config/config/example.yaml"),
  }
}

test("initCfg backfills only missing top-level keys and preserves existing values", async () => {
  const state = await loadCfg()
  const updated = state.userFile()
  const parsed = YAML.parse(updated.toString("utf8"))

  assert.deepEqual(Object.keys(parsed).sort(), ["added", "existing", "other", "untouched"])
  assert.deepEqual(parsed.existing, { keep: "user-value", nested: { userOnly: true } })
  assert.equal(parsed.untouched, false)
  assert.deepEqual(parsed.added, { keep: "default-value", nested: { fromTemplate: true } })
  assert.deepEqual(parsed.other, { enabled: true })
  assert.ok(updated.subarray(0, EXISTING_USER.length).equals(EXISTING_USER))
  assert.ok(updated.toString("utf8").includes("# new top-level section"))
  assert.ok(updated.toString("utf8").includes("# another new section"))
  assert.equal(state.calls.filter(([method]) => method === "copyFileSync").length, 0)
})

test("initCfg copies a missing file instead of backfilling it", async () => {
  const state = await loadCfg({ existing: false })
  assert.deepEqual(state.calls.filter(([method]) => method === "copyFileSync"), [
    ["copyFileSync", "config/default_config/example.yaml", "config/config/example.yaml"],
  ])
  assert.equal(state.calls.filter(([method]) => method === "writeFileSync").length, 0)
  assert.equal(state.userFile().toString("utf8"), DEFAULT_TEMPLATE)
})

test("backfillCfg never recursively adds missing nested keys", async () => {
  const template = `existing:\n  keep: default-value\n  nested:\n    fromTemplate: true\n${DEFAULT_TEMPLATE}`
  const state = await loadCfg({ template })
  state.cfg.backfillCfg("config/config/", "config/default_config/", "example.yaml")
  assert.ok(state.userFile().subarray(0, EXISTING_USER.length).equals(EXISTING_USER))
  assert.equal(YAML.parse(state.userFile().toString("utf8")).existing.nested.fromTemplate, undefined)
  assert.equal(YAML.parse(state.userFile().toString("utf8")).existing.keep, "user-value")
})

test("backfillCfg is idempotent when every template key already exists", async () => {
  const complete = `${DEFAULT_TEMPLATE}\nexisting:\n  keep: user-value\n  nested:\n    userOnly: true\nuntouched: false\n`
  const state = await loadCfg({ user: Buffer.from(complete), template: complete })
  state.cfg.backfillCfg("config/config/", "config/default_config/", "example.yaml")
  assert.equal(state.userFile().toString("utf8"), complete)
  assert.equal(state.calls.filter(([method]) => method === "writeFileSync").length, 0)
  assert.equal(state.calls.filter(([method]) => method === "renameSync").length, 0)
})

test("invalid YAML leaves the user file byte-for-byte unchanged and performs no write", async () => {
  const malformed = Buffer.from("existing: [unterminated\n", "utf8")
  const state = await loadCfg({ user: malformed })
  assert.ok(state.userFile().equals(malformed))
  assert.equal(state.calls.filter(([method]) => method === "writeFileSync").length, 0)
  assert.equal(state.calls.filter(([method]) => method === "renameSync").length, 0)
  assert.ok(state.logs.some(line => line.includes("模板补键失败")))
  assert.ok(state.logs.some(line => line.includes("Flow sequence in block collection must be sufficiently indented and end with a ]")))
  assert.ok(state.parsedTexts.every(text => !text.includes(DEFAULT_TEMPLATE)))
})

test("a failed rename preserves the original file bytes", async () => {
  const state = await loadCfg({ renameFails: true })
  assert.ok(state.userFile().equals(EXISTING_USER))
  assert.deepEqual(state.calls.filter(([method]) => method === "renameSync"), [
    ["renameSync", "config/config/example.yaml.backfill.tmp", "config/config/example.yaml"],
  ])
  assert.ok(state.files.has("config/config/example.yaml.backfill.tmp"))
  assert.ok(state.logs.some(line => line.includes("fixture rename failure")))
})

test("backfill preserves the entire existing file as a byte prefix, including trailing whitespace", async () => {
  const trailingWhitespace = Buffer.from("# preserve every trailing byte\nkey: value\n \t\n\n", "utf8")
  const state = await loadCfg({ user: trailingWhitespace, template: "newKey: new-value\n" })
  const updated = state.userFile()

  assert.ok(
    updated.subarray(0, trailingWhitespace.length).equals(trailingWhitespace),
    "the original file must remain an exact byte prefix; trailing whitespace must not be trimmed",
  )
  assert.deepEqual(YAML.parse(updated.toString("utf8")), { key: "value", newKey: "new-value" })
})
