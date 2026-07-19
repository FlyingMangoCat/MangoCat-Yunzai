import Renderer from "../../../lib/renderer/Renderer.js"
import os from "node:os"
import lodash from "lodash"
import puppeteer from "puppeteer"
import timers from "node:timers/promises"
import fs from "node:fs/promises"
import cfg from "../../../lib/config/config.js"

const _path = process.cwd()
let mac = ""

export default class Puppeteer extends Renderer {
  constructor(config) {
    super({
      id: "puppeteer",
      type: "image",
      render: "screenshot",
    })
    this.browser = false
    this.lock = false
    this.shoting = []
    /** 截图数达到时重启浏览器 避免生成速度越来越慢 */
    this.restartNum = 100
    /** 截图次数 */
    this.renderNum = 0
    this.config = {
      userDataDir: config.userDataDir || "data/puppeteer",
      headless: config.headless || "new",
      args: config.args || [
        "--disable-gpu",
        "--disable-setuid-sandbox",
        "--no-sandbox",
        "--no-zygote",
      ],
    }
    if (config.chromiumPath || cfg?.bot?.chromium_path)
      this.config.executablePath = config.chromiumPath || cfg?.bot?.chromium_path
    if (config.puppeteerWS || cfg?.bot?.puppeteer_ws)
      this.config.wsEndpoint = config.puppeteerWS || cfg?.bot?.puppeteer_ws
    this.puppeteerTimeout = config.puppeteerTimeout || cfg?.bot?.puppeteer_timeout || 0
    this.pageGotoParams = config.pageGotoParams || {
      timeout: 120000,
      waitUntil: "networkidle2",
    }
  }

  /**
   * 初始化chromium
   */
  async browserInit() {
    if (this.browser) return this.browser
    if (this._initPromise) return this._initPromise

    this._initPromise = this._doBrowserInit()
    return this._initPromise
  }

  async _doBrowserInit() {
    this.lock = true

    logger.info("puppeteer Chromium 启动中...")

    let connectFlag = false
    try {
      // 获取Mac地址
      if (!mac) {
        mac = await this.getMac()
        this.browserMacKey = `Yz:chromium:browserWSEndpoint:${mac}`
      }
      // 是否有browser实例
      const browserUrl = (await redis.get(this.browserMacKey)) || this.config.wsEndpoint
      if (browserUrl) {
        try {
          const browserWSEndpoint = await puppeteer.connect({ browserWSEndpoint: browserUrl })
          // 如果有实例，直接使用
          if (browserWSEndpoint) {
            this.browser = browserWSEndpoint
            connectFlag = true
          }
          logger.info(`puppeteer Chromium 连接成功 ${browserUrl}`)
        } catch (err) {
          await redis.del(this.browserMacKey)
        }
      }
    } catch {}

    if (!this.browser || !connectFlag) {
      this.browser = await puppeteer.launch(this.config).catch(async (err, trace) => {
        const errMsg = err.toString() + (trace ? trace.toString() : "")
        logger.error(err, trace)
        if (errMsg.includes("Could not find Chromium")) {
          logger.error(
            "没有正确安装 Chromium，可以尝试执行安装命令：node node_modules/puppeteer/install.js",
          )
        } else if (errMsg.includes("cannot open shared object file")) {
          logger.error("没有正确安装 Chromium 运行库")
        } else if (errMsg.includes(this.config.userDataDir)) {
          await fs.rm(this.config.userDataDir, { force: true, recursive: true }).catch(() => {})
          this.lock = false
          this._initPromise = null
          return this.browserInit()
        }
      })
      if (this.lock === false) return this.browserInit()
    }

    this.lock = false
    this._initPromise = null
    if (!this.browser) {
      logger.error("puppeteer Chromium 启动失败")
      return false
    }
    if (!connectFlag) {
      logger.info(`puppeteer Chromium 启动成功 ${this.browser.wsEndpoint()}`)
      if (this.browserMacKey) {
        const expireTime = 60 * 60 * 24 * 30
        await redis.set(this.browserMacKey, this.browser.wsEndpoint(), { EX: expireTime })
      }
    }

    this.browser.on("disconnected", () => this.restart(true))

    return this.browser
  }

  getMac() {
    let mac = "00:00:00:00:00:00"
    try {
      const network = os.networkInterfaces()
      let macFlag = false
      for (const a in network) {
        for (const i of network[a]) {
          if (i.mac && i.mac !== mac) {
            macFlag = true
            mac = i.mac
            break
          }
        }
        if (macFlag) break
      }
    } catch (e) {}
    mac = mac.replace(/:/g, "")
    return mac
  }

  async screenshot(name, data = {}) {
    if (!(await this.browserInit())) return false
    const pageHeight = data.multiPageHeight || 4000

    const savePath = this.dealTpl(name, data)
    if (!savePath) return false

    let buff = ""
    const start = Date.now()

    let ret = []
    this.shoting.push(name)

    const puppeteerTimeout = this.puppeteerTimeout
    let overtime
    if (puppeteerTimeout > 0) {
      overtime = setTimeout(() => {
        if (this.shoting.length) {
          logger.error(`[图片生成][${name}] 截图超时，当前等待队列：${this.shoting.join(",")}`)
          this.restart(true)
          this.shoting = []
        }
      }, puppeteerTimeout)
    }

    try {
      const page = await this.browser.newPage()
      const pageGotoParams = lodash.extend(this.pageGotoParams, data.pageGotoParams || {})
      await page.goto(`file://${_path}${lodash.trim(savePath, ".")}`, pageGotoParams)
      const body = (await page.$("#container")) || (await page.$("body"))

      const boundingBox = await body.boundingBox()
      let num = 1

      const randData = {
        type: data.imgType || "jpeg",
        omitBackground: data.omitBackground || false,
        quality: data.quality || 90,
        path: data.path || "",
      }

      if (data.multiPage) {
        randData.type = "jpeg"
        num = Math.round(boundingBox.height / pageHeight) || 1
      }

      if (data.imgType === "png") delete randData.quality

      if (!data.multiPage) {
        buff = await body.screenshot(randData)
        if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)

        this.renderNum++
        const kb = (buff.length / 1024).toFixed(2) + "KB"
        logger.mark(
          `[图片生成][${name}][${this.renderNum}次] ${kb} ${logger.green(`${Date.now() - start}ms`)}`,
        )
        ret.push(buff)
      } else {
        if (num > 1) {
          await page.setViewport({
            width: boundingBox.width,
            height: pageHeight + 100,
          })
        }
        for (let i = 1; i <= num; i++) {
          if (i !== 1 && i === num)
            await page.setViewport({
              width: boundingBox.width,
              height: parseInt(boundingBox.height) - pageHeight * (num - 1),
            })

          if (i !== 1 && i <= num)
            await page.evaluate(pageHeight => window.scrollBy(0, pageHeight), pageHeight)

          if (num === 1) buff = await body.screenshot(randData)
          else buff = await page.screenshot(randData)
          if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)

          if (num > 2) await timers.setTimeout(200)

          this.renderNum++

          const kb = (buff.length / 1024).toFixed(2) + "KB"
          logger.mark(`[图片生成][${name}][${i}/${num}] ${kb}`)
          ret.push(buff)
        }
        if (num > 1) {
          logger.mark(`[图片生成][${name}] 处理完成`)
        }
      }
      page.close().catch(err => logger.error(err))
    } catch (err) {
      logger.error(`[图片生成][${name}] 图片生成失败`, err)
      this.restart(true)
      if (overtime) clearTimeout(overtime)
      ret = []
      return false
    } finally {
      if (overtime) clearTimeout(overtime)
    }

    this.shoting.pop()

    if (ret.length === 0 || !ret[0]) {
      logger.error(`[图片生成][${name}] 图片生成为空`)
      return false
    }

    this.restart()
    return data.multiPage ? ret : ret[0]
  }

  /** 重启 */
  restart(force = false) {
    if (!this.browser?.close || this.lock) return
    if (!force) if (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0) return
    logger.info(`puppeteer Chromium ${force ? "强制" : ""}关闭重启...`)
    this.stop(this.browser)
    this.browser = false
    return this.browserInit()
  }

  async stop(browser) {
    try {
      await browser.close()
    } catch (err) {
      logger.error("puppeteer Chromium 关闭错误", err)
    }
  }
}