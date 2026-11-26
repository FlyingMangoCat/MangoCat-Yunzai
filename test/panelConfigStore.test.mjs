import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const storeUrl = pathToFileURL(path.join(root, "lib/panel/configStore.js")).href
const tempRoot = path.join(root, "temp")

function inStore(body) {
  fs.mkdirSync(tempRoot, { recursive: true })
  const cwd = fs.mkdtempSync(path.join(tempRoot, "config-store-"))
  const prelude = `
    import assert from "node:assert/strict"
    import fs from "node:fs"
    import path from "node:path"
    import * as store from ${JSON.stringify(storeUrl)}
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    }
    const read = file => fs.readFileSync(file, "utf8")
  `
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", prelude + body], {
      cwd,
      encoding: "utf8",
      timeout: 30000,
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

test("YAML sources prefer user files and never return sensitive values", () => inStore(`
  write("config/default_config/demo.yaml", "token: default-secret\\npassword: default-password\\ncount: 1\\n")
  write("config/config/demo.yaml", "token: user-secret\\npassword: user-password\\ncount: 2\\n")
  const result = store.readYamlSource("yunzai", "demo.yaml")
  assert.equal(result.fromDefault, false)
  const fields = Object.fromEntries(result.fields.map(field => [field.key, field]))
  assert.equal(fields.token.value, "")
  assert.equal(fields.token.set, true)
  assert.equal(fields.password.sensitive, true)
  assert.equal(fields.count.value, 2)
`))

test("YAML writes patch only requested fields, keep blank secrets, validate numbers and back up atomically", () => inStore(`
  write("config/config/demo.yaml", "token: keep-me\\ncount: 1\\nname: old\\n")
  const saved = store.writeYamlSource("yunzai", "demo.yaml", [
    { path: ["count"], value: "2.5" },
    { path: ["name"], value: "new" },
    { path: ["token"], value: "" },
  ])
  const text = read("config/config/demo.yaml")
  assert.match(text, /token: keep-me/)
  assert.match(text, /count: 2\\.5/)
  assert.match(text, /name: new/)
  assert.ok(saved.backup)
  assert.equal(read(saved.backup), "token: keep-me\\ncount: 1\\nname: old\\n")
  assert.equal(fs.existsSync("config/config/demo.yaml.tmp-" + process.pid), false)
  assert.throws(() => store.writeYamlSource("yunzai", "demo.yaml", [{ path: ["count"], value: "NaN" }]), /需要数字/)
  assert.throws(() => store.writeYamlSource("yunzai", "demo.yaml", []), /没有需要保存/)
  assert.equal(read("config/config/demo.yaml"), text)
`))

test("invalid YAML is rejected without creating a backup or replacing the user file", () => inStore(`
  write("config/config/demo.yaml", "broken: [\\n")
  assert.throws(() => store.readYamlSource("yunzai", "demo.yaml"), /解析失败/)
  assert.throws(() => store.writeYamlSource("yunzai", "demo.yaml", [{ path: ["ok"], value: true }]), /解析失败/)
  assert.equal(read("config/config/demo.yaml"), "broken: [\\n")
  assert.equal(fs.existsSync("data/panel_backup"), false)
`))

test("file keys cannot escape YAML roots through traversal, absolute paths, drive paths or backslashes", () => inStore(`
  write("config/default_config/demo.yaml", "safe: true\\n")
  write("outside.yaml", "secret: outside\\n")
  const keys = ["../../outside.yaml", "nested/../../outside.yaml", "../outside.yaml", "/outside.yaml", "C:\\\\outside.yaml", "..\\\\outside.yaml", "bad\\0key.yaml"]
  for (const key of keys) {
    assert.throws(() => store.readYamlSource("yunzai", key), /未知配置来源/)
    assert.throws(() => store.writeYamlSource("yunzai", key, [{ path: ["safe"], value: false }]), /未知配置来源/)
  }
  assert.equal(read("outside.yaml"), "secret: outside\\n")
  write("config/default_config/nested/demo.yaml", "safe: true\\n")
  assert.equal(store.readYamlSource("yunzai", "nested/demo.yaml").fields[0].value, true)
`))

test("plugin source names and file keys cannot escape the selected plugin", () => inStore(`
  write("plugins/demo/config/config/demo.yaml", "value: 1\\n")
  write("plugins/outside.yaml", "value: 9\\n")
  for (const source of ["plugin:../outside", "plugin:../../outside", "plugin:demo/../outside", "plugin:.", "plugin:"]) {
    assert.throws(() => store.readYamlSource(source, "demo.yaml"), /未知配置来源/)
    assert.throws(() => store.writeYamlSource(source, "demo.yaml", [{ path: ["value"], value: 2 }]), /未知配置来源/)
  }
  assert.throws(() => store.readYamlSource("plugin:demo", "../../outside.yaml"), /未知配置来源/)
  assert.equal(store.readYamlSource("plugin:demo", "demo.yaml").fields[0].value, 1)
  assert.equal(read("plugins/outside.yaml"), "value: 9\\n")
`))

test("source discovery lists only YAML files and skips dependency and git directories", () => inStore(`
  write("config/default_config/b.yaml", "b: 1\\n")
  write("config/config/a.yaml", "a: 1\\n")
  write("config/config/readme.txt", "ignored\\n")
  write("plugins/demo/config/config/plugin.yml", "value: 1\\n")
  write("plugins/demo/config/config/node_modules/pkg/x.yaml", "bad: true\\n")
  write("plugins/demo/config/config/.git/x.yaml", "bad: true\\n")
  write("plugins/empty/guoba.support.js", "export function supportGuoba() {}\\n")
  const sources = store.sources()
  const yunzai = sources.find(source => source.id === "yunzai")
  assert.deepEqual(yunzai.files.map(file => file.key), ["a.yaml", "b.yaml"])
  const plugin = sources.find(source => source.id === "plugin:demo")
  assert.deepEqual(plugin.files.map(file => file.key), ["plugin.yml"])
  assert.ok(sources.some(source => source.id === "schema:empty"))
`))

test("a failed atomic rename preserves the original configuration", () => inStore(`
  write("config/config/demo.yaml", "value: old\\n")
  const rename = fs.renameSync
  fs.renameSync = () => { throw new Error("rename failed") }
  try {
    assert.throws(() => store.writeYamlSource("yunzai", "demo.yaml", [{ path: ["value"], value: "new" }]), /rename failed/)
  } finally {
    fs.renameSync = rename
  }
  assert.equal(read("config/config/demo.yaml"), "value: old\\n")
  assert.ok(fs.existsSync("config/config/demo.yaml.tmp-" + process.pid))
`))

test("group overrides validate IDs, preserve defaults and support removal", () => inStore(`
  write("config/default_config/group.yaml", "default:\\n  enabled: true\\n12345:\\n  enabled: false\\n")
  for (const id of ["1234", "1234567890123", "abc", "12 345"]) {
    assert.throws(() => store.writeGroup(id, [{ path: ["default", "enabled"], value: false }]), /群号不合法/)
  }
  store.writeGroup("54321", [{ path: ["default", "enabled"], value: false }, { path: ["count"], value: "3" }])
  const groups = store.readGroups()
  const group = groups.groups.find(item => item.id === "54321")
  const fields = Object.fromEntries(group.fields.map(field => [field.key, field]))
  assert.equal(fields.enabled.value, false)
  assert.equal(fields.count.value, "3")
  assert.equal(groups.defaultFields.find(field => field.key === "enabled").value, true)
  store.writeGroup("54321", [], true)
  assert.equal(store.readGroups().groups.some(item => item.id === "54321"), false)
`))
