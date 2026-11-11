// 运行：node --experimental-vm-modules --test tools/renderer-compat.test.mjs
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const root = fileURLToPath(new URL("../", import.meta.url))
const noop = () => {}
const unexpected = () => assert.fail("Unexpected external dependency call")

// 加载完整且未修改的源码，仅替换其导入依赖。
// 不导入应用、配置或启动入口，也不写入真实文件系统。
async function loadSource(relative, imports, globals = {}) {
  const context = vm.createContext({
    Buffer,
    process: { cwd: () => root },
    logger: { info: noop, warn: noop, error: noop, debug: noop, mark: noop, green: v => v },
    ...globals,
  })
  context.global = context
  const filename = path.join(root, relative)
  const source = new vm.SourceTextModule(await readFile(filename, "utf8"), {
    context,
    identifier: filename,
    importModuleDynamically: unexpected,
  })
  await source.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), `Unmocked import: ${specifier}`)
    const exports = imports[specifier]
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await source.evaluate()
  return source.namespace.default
}

function memoryFs() {
  const resolve = value => path.resolve(root, value)
  const dirs = new Set()
  const files = new Map()
  for (let dir = root; ; dir = path.dirname(dir)) {
    dirs.add(resolve(dir))
    if (path.dirname(dir) === dir) break
  }
  const fs = {
    existsSync: value => dirs.has(resolve(value)) || files.has(resolve(value)),
    mkdirSync(value) {
      assert.ok(dirs.has(path.dirname(resolve(value))), `Missing parent: ${value}`)
      dirs.add(resolve(value))
    },
    writeFileSync(value, contents) {
      assert.ok(dirs.has(path.dirname(resolve(value))), `Missing output directory: ${value}`)
      files.set(resolve(value), contents)
    },
    readFileSync(value) {
      assert.ok(files.has(resolve(value)), `Missing mock file: ${value}`)
      return files.get(resolve(value))
    },
  }
  return { fs, files, resolve }
}

async function rendererFixture() {
  const memory = memoryFs()
  const Renderer = await loadSource("lib/renderer/Renderer.js", {
    "node:path": { default: path },
    "node:fs": { default: memory.fs },
    "art-template": { default: { render: (html, data) => html.replace("{{value}}", data.value) } },
    chokidar: { default: { watch: unexpected } },
  })
  Renderer.html["fixture.html"] = "<main>{{value}}</main>"
  return { Renderer, ...memory }
}

async function loaderFixture(cfg = {}, backends = []) {
  const { Renderer } = await rendererFixture()
  const loader = await loadSource("lib/renderer/loader.js", {
    "node:fs": { default: { readdirSync: () => [] } },
    yaml: { default: { parse: unexpected } },
    lodash: { default: { isFunction: value => typeof value === "function" } },
    "../config/config.js": { default: cfg },
    "./Renderer.js": { default: Renderer },
  })
  for (const backend of backends) loader.renderers.set(backend.id, backend)
  await loader.load()
  return { loader, Renderer }
}

const backend = id => ({ id, support_script: true, render: async () => Buffer.from(id) })

test("loader returns existing explicit/configured/puppeteer backends", async () => {
  const preferred = backend("preferred")
  const puppeteer = backend("puppeteer")
  const cfg = { renderer: { name: "preferred" } }
  const { loader } = await loaderFixture(cfg, [preferred, puppeteer])
  assert.equal(loader.getRenderer(), preferred)
  assert.equal(loader.getRenderer("puppeteer"), puppeteer)
  assert.equal(loader.getRenderer("preferred"), preferred)
  cfg.renderer = undefined
  assert.equal(loader.getRenderer(), puppeteer)
  cfg.renderer = { name: "" }
  assert.equal(loader.getRenderer(), puppeteer)
})

test("loader preserves puppeteer preference when config access throws", async () => {
  const puppeteer = backend("puppeteer")
  const cfg = { get renderer() { throw new Error("fixture") } }
  const { loader } = await loaderFixture(cfg, [puppeteer])
  assert.equal(loader.getRenderer(), puppeteer)
})

for (const cfg of [{}, { renderer: { name: "missing" } }]) {
  test(`missing implicit backend returns the dispatcher (${JSON.stringify(cfg)})`, async () => {
    const { loader } = await loaderFixture(cfg, [backend("alternative")])
    assert.equal(loader.getRenderer(), loader)
    assert.deepEqual(await loader.getRenderer().render("view", { tplFile: "fixture.html" }),
      Buffer.from("alternative"))
    assert.equal(await loader.getRenderer().render("view", { tplFile: "missing.html" }), false)
  })
}

test("explicit unknown backend returns false, not the dispatcher or default", async () => {
  const { loader } = await loaderFixture({}, [backend("puppeteer")])
  assert.equal(loader.getRenderer("missing"), false)
})

test("implicit fallback retains existing script/no-script scheduling", async () => {
  const calls = []
  const scripted = { id: "scripted", support_script: true, render: async () => {
    calls.push("scripted")
    throw new Error("fixture backend failure")
  } }
  const plain = { id: "plain", support_script: false, render: async () => {
    calls.push("plain")
    return Buffer.from("plain")
  } }
  const { loader, Renderer } = await loaderFixture({}, [scripted, plain])
  Renderer.html["script.html"] = "<script></script>"
  const fallback = loader.getRenderer()
  assert.equal(fallback, loader)
  assert.deepEqual(await fallback.render("view", { tplFile: "script.html" }), Buffer.from("plain"))
  assert.deepEqual(calls, ["scripted", "plain"])
  calls.length = 0
  await fallback.render("view", { tplFile: "fixture.html" })
  assert.deepEqual(calls, ["plain"])
})

test("legacy wrapper imports and dispatches without an implicit default backend", async () => {
  const alternative = backend("alternative")
  alternative.render = async (name, data) => data.multiPage ? ["one", "two"] : "one"
  const { loader } = await loaderFixture({}, [alternative])
  const wrapper = await loadSource("lib/puppeteer/puppeteer.js", {
    "../renderer/loader.js": { default: loader },
  }, { segment: { image: value => ({ image: value }) } })
  assert.equal(wrapper, loader)
  assert.deepEqual(await wrapper.screenshot("view", { tplFile: "fixture.html" }), { image: "one" })
  const pages = await wrapper.screenshots("view", { tplFile: "fixture.html" })
  assert.deepEqual(Array.from(pages), [{ image: "one" }, { image: "two" }])
})

test("default saveId is the basename of a stringified screenshot name", async () => {
  const { Renderer } = await rendererFixture()
  for (const [name, expected] of [["view", "view"], ["plugin/view", "view"], [42, "42"]]) {
    assert.equal(Renderer.getTplPath(name, {}), `./temp/html/${name}/${expected}.html`)
    assert.equal(Renderer.getTplPath(name, { saveId: null }), `./temp/html/${name}/${expected}.html`)
  }
})

test("explicit saveId semantics are unchanged", async () => {
  const { Renderer } = await rendererFixture()
  for (const saveId of ["nested/card", "nested/../card", "", 0]) {
    assert.equal(Renderer.getTplPath("plugin/view", { saveId }),
      `./temp/html/plugin/view/${saveId}.html`)
  }
})

for (const [label, data, expected] of [
  ["implicit", {}, "./temp/html/plugin/view/view.html"],
  ["nested explicit", { saveId: "nested/card" }, "./temp/html/plugin/view/nested/card.html"],
]) {
  test(`dealTpl creates the output parent for ${label} saveId`, async () => {
    const { Renderer, files, resolve } = await rendererFixture()
    const input = { tplFile: "fixture.html", value: "rendered", ...data }
    assert.equal(Renderer.dealTpl("plugin/view", input), expected)
    assert.equal(files.get(resolve(expected)), "<main>rendered</main>")
    assert.equal(input.resPath, "./resources/")
    assert.equal(files.size, 1)
  })
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function puppeteerFixture() {
  const fixture = await rendererFixture()
  const Puppeteer = await loadSource("renderers/puppeteer/lib/puppeteer.js", {
    "../../../lib/renderer/Renderer.js": { default: fixture.Renderer },
    "node:os": { default: { networkInterfaces: unexpected } },
    lodash: { default: { extend: Object.assign, trim: value => value.replace(/^\.+|\.+$/g, "") } },
    puppeteer: { default: { launch: unexpected, connect: unexpected } },
    "node:timers/promises": { default: { setTimeout: unexpected } },
    "node:fs/promises": { default: { rm: unexpected } },
    "../../../lib/config/config.js": { default: { bot: {} } },
  })
  return { ...fixture, Puppeteer }
}

for (const [label, config, expected] of [
  ["false", { headless: false }, false],
  ["undefined", {}, "new"],
  ["null", { headless: null }, "new"],
  ["true", { headless: true }, true],
  ["shell", { headless: "shell" }, "shell"],
]) {
  test(`puppeteer headless preserves ${label}`, async () => {
    const { Puppeteer } = await puppeteerFixture()
    const args = ["--fixture"]
    const instance = new Puppeteer({ ...config, args, userDataDir: "fixture", unrelated: true })
    assert.equal(instance.config.headless, expected)
    assert.equal(instance.config.args, args)
    assert.equal(instance.config.userDataDir, "fixture")
    assert.deepEqual(Object.keys(instance.config).sort(), ["args", "headless", "userDataDir"])
  })
}

for (const outcome of ["success", "false", "throw"]) {
  test(`screenshot path lock serializes aliases and releases after ${outcome}`, async () => {
    const { Renderer, Puppeteer, files, resolve } = await puppeteerFixture()
    const instance = new Puppeteer({})
    const gate = deferred()
    const entered = deferred()
    const events = []
    const firstData = { tplFile: "fixture.html", value: "first" }
    const secondData = { tplFile: "fixture.html", value: "second", saveId: "nested/../view" }
    instance.captureScreenshot = async (name, data) => {
      events.push(data.value)
      const saved = instance.dealTpl(name, data)
      if (data.value === "first") {
        entered.resolve()
        await gate.promise
        assert.equal(files.get(resolve(saved)), "<main>first</main>")
        if (outcome === "throw") throw new Error("fixture screenshot failure")
        if (outcome === "false") return false
      }
      return data.value
    }
    const first = instance.screenshot("plugin/view", firstData)
    const firstResult = outcome === "throw"
      ? assert.rejects(first, /fixture screenshot failure/)
      : first.then(value => assert.equal(value, outcome === "false" ? false : "first"))
    // 与渲染结束竞速，回归时不能在前置等待阶段静默挂住。
    await Promise.race([entered.promise, firstResult])
    const second = instance.screenshot("plugin/view", secondData)
    const independent = instance.screenshot("plugin/view", {
      tplFile: "fixture.html", value: "independent", saveId: "other",
    })
    try {
      await new Promise(setImmediate)
      assert.deepEqual(events, ["first", "independent"])
      assert.equal(await independent, "independent")
    } finally {
      gate.resolve()
      await Promise.allSettled([first, second, independent])
    }
    await firstResult
    assert.equal(await second, "second")
    assert.equal(files.get(resolve(Renderer.getTplPath("plugin/view", firstData))), "<main>second</main>")
    assert.equal(Renderer.tplQueue.size, 0)
  })
}

test("real screenshot flow writes nested HTML and returns a mock browser buffer", async () => {
  const { Puppeteer, files, resolve } = await puppeteerFixture()
  const instance = new Puppeteer({})
  const image = Buffer.from("fixture screenshot")
  let closed = false
  const body = {
    boundingBox: async () => ({ width: 80, height: 40 }),
    screenshot: async () => image,
  }
  instance.browserInit = async () => true
  instance.browser = { newPage: async () => ({
    goto: async () => assert.equal(files.get(resolve("./temp/html/plugin/view/nested/card.html")),
      "<main>offline</main>"),
    $: async () => body,
    close: async () => { closed = true },
  }) }
  assert.deepEqual(await instance.screenshot("plugin/view", {
    tplFile: "fixture.html", value: "offline", saveId: "nested/card",
  }), image)
  assert.equal(closed, true)
  assert.equal(instance.renderNum, 1)
  assert.equal(instance.shoting.length, 0)
})

async function roleFixture() {
  class Base {
    constructor(e) {
      this.e = e
      this.screenData = { pluResPath: "fixture/", tplFile: "role-card.html" }
    }
  }
  return loadSource("plugins/genshin/model/roleIndex.js", {
    "./base.js": { default: Base },
    "./mys/mysInfo.js": { default: { get: unexpected } },
    "./gsCfg.js": { default: { getdefSet: () => ({}) } },
    lodash: { default: {
      forEach: (value, fn) => Object.entries(value).forEach(([key, item]) => fn(item, key)),
      invert: value => Object.fromEntries(Object.entries(value).map(([key, item]) => [item, key])),
      random: min => min,
      orderBy: value => value,
    } },
    moment: { default: unexpected },
    "node:fs": { default: {} },
    "#liulian.models": { Character: { get: unexpected } },
  })
}

for (const [label, sender, expected] of [
  ["card takes priority", { card: "  Card 123456789  ", nickname: "Nickname" }, "Card"],
  ["nickname without card", { nickname: "  Nickname 123456789  " }, "Nickname"],
  ["empty card", { card: "", nickname: "Nickname" }, "Nickname"],
  ["null card", { card: null, nickname: "Nickname" }, "Nickname"],
  ["missing card and nickname", {}, ""],
  ["missing sender", undefined, ""],
  ["null sender", null, ""],
  ["whitespace card retains existing behavior", { card: "  ", nickname: "Nickname" }, ""],
]) {
  test(`roleCardData handles ${label} without changing other output fields`, async () => {
    const RoleIndex = await roleFixture()
    const model = new RoleIndex({ uid: "123456789", user_id: 42, sender })
    const data = model.roleCardData({
      stats: {
        active_day_number: 7, achievement_number: 8, avatar_number: 9,
        precious_chest_number: 1, luxurious_chest_number: 2,
        exquisite_chest_number: 3, common_chest_number: 4, magic_chest_number: 5,
      },
      role: { level: 60 },
      world_explorations: [],
      avatars: [],
    })
    assert.equal(data.name, expected)
    assert.equal(data.uid, "123456789")
    assert.equal(data.saveId, "123456789")
    assert.equal(data.user_id, 42)
    assert.equal(data.tplFile, "role-card.html")
    assert.equal(data.pluResPath, "fixture/")
    assert.equal(data.bg, 1)
    assert.equal(data.avatars.length, 0)
    assert.deepEqual(Array.from(data.line[0], item => item.num), [7, 8, 9, 60, 15])
  })
}
