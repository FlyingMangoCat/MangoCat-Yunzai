import fs from "node:fs"
import yaml from "yaml"
import lodash from "lodash"
import cfg from "../config/config.js"
import Renderer from "./Renderer.js"

/** 全局变量 Renderer */
global.Renderer = Renderer

/**
 * 加载渲染器
 */
class RendererLoader {
  constructor() {
    this.renderers = new Map()
    this.dir = "./renderers"
    this.watcher = {}
  }

  static async init() {
    const render = new RendererLoader()
    await render.load()
    return render
  }

  async load() {
    const subFolders = fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
    for (let subFolder of subFolders) {
      let name = subFolder.name
      try {
        const rendererModule = await import(`${process.cwd()}/${this.dir}/${name}/index.js`)
        const rendererFn = rendererModule.default || rendererModule
        let configFile = `${this.dir}/${name}/config.yaml`
        let configDefault = `${this.dir}/${name}/config_default.yaml`
        let rendererCfg = {}
        if (fs.existsSync(configFile)) {
          rendererCfg = yaml.parse(fs.readFileSync(configFile, "utf8"))
        } else if (fs.existsSync(configDefault)) {
          rendererCfg = yaml.parse(fs.readFileSync(configDefault, "utf8"))
        }
        let renderer = rendererFn(rendererCfg)
        if (
          !renderer.id ||
          !renderer.type ||
          !renderer.render ||
          !lodash.isFunction(renderer.render)
        ) {
          logger.warn("渲染后端 " + (renderer.id || subFolder.name) + " 不可用")
        }
        this.renderers.set(renderer.id, renderer)
        logger.info(`加载渲染后端 ${renderer.id}`)
      } catch (err) {
        logger.error(`渲染后端 ${name} 加载失败`)
        logger.error(err)
      }
    }
    const renderers = [...this.renderers.values()]
    this.script_renderers = [
      ...renderers.filter(i => i.support_script),
      ...renderers.filter(i => !i.support_script),
    ]
    this.noscript_renderers = [
      ...renderers.filter(i => !i.support_script),
      ...renderers.filter(i => i.support_script),
    ]
  }

  getRenderer(name) {
    let rendererName = name
    if (!rendererName) {
      try {
        rendererName = cfg.renderer?.name || "puppeteer"
      } catch {
        rendererName = "puppeteer"
      }
    }
    return this.renderers.get(rendererName)
  }

  async render(name, data) {
    const html = Renderer.readTpl(data.tplFile)
    if (!html) return false
    for (const i of html.includes("</script>") ? this.script_renderers : this.noscript_renderers)
      try {
        const res = await i.render(name, data)
        if (res) return res
      } catch (err) {
        logger.error(`渲染后端 ${i.id} 渲染错误`, err)
      }
  }
}

export default await RendererLoader.init()