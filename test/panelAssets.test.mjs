import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const pluginsUrl = pathToFileURL(path.join(root, "lib/panel/plugins.js")).href
const tempRoot = path.join(root, "temp")

function withPlugins(body) {
  fs.mkdirSync(tempRoot, { recursive: true })
  const cwd = fs.mkdtempSync(path.join(tempRoot, "panel-assets-"))
  fs.mkdirSync(path.join(cwd, "config/default_config"), { recursive: true })
  fs.mkdirSync(path.join(cwd, "config/config"), { recursive: true })
  fs.writeFileSync(path.join(cwd, "config/default_config/panel.yaml"), "panel: {}\n")
  const prelude = `
    import assert from "node:assert/strict"
    import fs from "node:fs"
    import path from "node:path"
    import * as plugins from ${JSON.stringify(pluginsUrl)}
    const write = (file, data = "") => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, data)
    }
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

test("plugin assets resolve only supported image files inside a recognized plugin", () => withPlugins(`
  write("plugins/demo/index.js", "export default {}\\n")
  write("plugins/demo/assets/icon.svg", "<svg/>\\n")
  const asset = plugins.resolvePluginAsset("demo", "assets/icon.svg")
  assert.equal(asset.ext, ".svg")
  assert.equal(fs.readFileSync(asset.path, "utf8"), "<svg/>\\n")
  for (const rel of ["../secret.png", "/secret.png", "C:\\\\secret.png", "assets/../../secret.png", "assets/icon.svg\\0", "package.json", "missing.png", "assets"]) {
    assert.throws(() => plugins.resolvePluginAsset("demo", rel))
  }
  assert.throws(() => plugins.resolvePluginAsset("missing", "icon.png"))
`))

test("asset resolution rejects symlink escapes", () => withPlugins(`
  write("plugins/demo/index.js", "export default {}\\n")
  write("outside/secret.png", "secret")
  fs.mkdirSync("plugins/demo/assets", { recursive: true })
  let linked = true
  try {
    fs.symlinkSync(path.resolve("outside"), path.resolve("plugins/demo/assets/link"), "junction")
  } catch (error) {
    if (error.code === "EPERM") linked = false
    else throw error
  }
  if (linked) assert.throws(() => plugins.resolvePluginAsset("demo", "assets/link/secret.png"), /资源路径不合法/)
`))

test("README lookup accepts common casing and truncates oversized content", () => withPlugins(`
  write("plugins/demo/index.js", "export default {}\\n")
  write("plugins/demo/Readme.md", "# Demo\\n")
  assert.equal(plugins.readReadme("demo").text, "# Demo\\n")
  write("plugins/demo/Readme.md", "x".repeat(300 * 1024 + 1))
  const result = plugins.readReadme("demo")
  assert.equal(result.text.length, 300 * 1024)
  assert.equal(result.truncated, true)
  assert.throws(() => plugins.readReadme("missing"), /插件不存在/)
`))

test("README lookup rejects non-plugin directories", () => withPlugins(`
  write("plugins/plain/README.md", "not a plugin")
  write("plugins/adapter/README.md", "reserved")
  write("plugins/.hidden/README.md", "hidden")
  assert.throws(() => plugins.readReadme("plain"), /插件不存在/)
  assert.throws(() => plugins.readReadme("adapter"), /插件不存在/)
  assert.throws(() => plugins.readReadme(".hidden"), /插件不存在/)
`))
