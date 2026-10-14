import template from "art-template"
import chokidar from "chokidar"
import path from "node:path"
import fs from "node:fs"

export default class Renderer {
  /**
   * 渲染器
   * @param data.id 渲染器ID
   * @param data.type 渲染器类型
   * @param data.render 渲染器入口
   */
  constructor(data) {
    /** 渲染器ID */
    this.id = data.id || "renderer"
    /** 渲染器类型 */
    this.type = data.type || "image"
    /** 渲染器入口 */
    this.render = this[data.render || "render"]
    /** 支持 <script> */
    this.support_script = data.support_script ?? true
    this.dealTpl = Renderer.dealTpl.bind(Renderer)
  }

  static dir = "./temp/html"
  static html = {}
  static watcher = {}
  /** 模板输出路径锁：同一路径的渲染串行执行，避免并发截图覆盖正在读取的模板文件 */
  static tplQueue = new Map()

  /** 创建文件夹 */
  static createDir(dirname) {
    if (fs.existsSync(dirname)) {
      return true
    } else {
      if (this.createDir(path.dirname(dirname))) {
        fs.mkdirSync(dirname)
        return true
      }
    }
  }

  /** 读取html模板 */
  static readTpl(tplFile) {
    if (!this.html[tplFile]) {
      try {
        this.html[tplFile] = fs.readFileSync(tplFile, "utf8")
      } catch (error) {
        logger.error(`加载html错误：${tplFile}`)
        return false
      }
      this.watch(tplFile)
    }
    return this.html[tplFile]
  }

  /** 模板渲染产物的落盘路径 */
  static getTplPath(name, data) {
    return `./temp/html/${name}/${data.saveId ?? name}.html`
  }

  /**
   * 按模板输出路径串行执行渲染：同一 HTML 路径的请求排队，
   * 上一个截图读取完毕（无论成败）才允许覆盖写入，防止并发截图互相污染；
   * 不同路径之间不受影响，仍然并发
   * @param {string} name 模板名称
   * @param {object} data 模板参数
   * @param {Function} render 本次渲染操作
   * @returns {Promise<*>} 渲染结果
   */
  static async withTpl(name, data, render) {
    const key = path.resolve(this.getTplPath(name, data))
    const previous = this.tplQueue.get(key) || Promise.resolve()
    let release
    const current = new Promise(resolve => (release = resolve))
    this.tplQueue.set(key, current)
    await previous
    try {
      return await render()
    } finally {
      release()
      if (this.tplQueue.get(key) === current) this.tplQueue.delete(key)
    }
  }

  /** 模板 */
  static dealTpl(name, data) {
    const html = this.readTpl(data.tplFile)
    if (!html) return false

    /** 替换模板 */
    data.resPath = `./resources/`
    const tmpHtml = template.render(html, data)
    /** 保存模板 */
    this.createDir(`./temp/html/${name}`)
    const savePath = this.getTplPath(name, data)
    fs.writeFileSync(savePath, tmpHtml)

    logger.debug(`[图片生成][使用模板] ${savePath}`)
    return savePath
  }

  /** 监听配置文件 */
  static watch(tplFile) {
    if (this.watcher[tplFile]) return

    const watcher = chokidar.watch(tplFile)
    watcher.on("change", () => {
      delete this.html[tplFile]
      logger.mark(`[修改html模板] ${tplFile}`)
    })

    this.watcher[tplFile] = watcher
  }
}