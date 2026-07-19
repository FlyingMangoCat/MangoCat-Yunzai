import { segment } from "icqq"
import PuppeteerRenderer from "../../renderers/puppeteer/lib/puppeteer.js"

const _path = process.cwd()

let renderer = new PuppeteerRenderer({})

/**
 * 截图
 * 兼容旧版 puppeteer.screenshot 接口，返回 segment.image
 */
renderer.screenshot = async (name, data) => {
  let img = await PuppeteerRenderer.prototype.screenshot.call(renderer, name, data)
  return img ? segment.image(img) : img
}

/**
 * 分片截图
 */
renderer.screenshots = async (name, data) => {
  data.multiPage = true
  let imgs = (await PuppeteerRenderer.prototype.screenshot.call(renderer, name, data)) || []
  let ret = []
  for (let img of imgs) {
    ret.push(img ? segment.image(img) : img)
  }
  return ret.length > 0 ? ret : false
}

export default renderer