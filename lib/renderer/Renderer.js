import { segment } from "icqq";
import { createCanvas, loadImage } from "canvas";
import { puppeteer } from "../puppeteer/puppeteer.js";
import fs from "fs";
import cfg from "../config/config.js";

export default class Renderer {
  constructor() {
    this.renderer = cfg.renderer;
  }

  static async render(path, params, cfg) {
    const renderer = new Renderer();

    if (renderer.renderer?.mode === "canvas") {
      return await renderer.renderByCanvas(path, params, cfg);
    } else {
      return await renderer.renderByPuppeteer(path, params, cfg);
    }
  }

  async renderByPuppeteer(path, params, cfg) {
    const html = fs.readFileSync(`resources/html/${path}/index.html`, "utf8");
    const template = _.template(html);
    const htmlContent = template(params);

    const page = await puppeteer.browser.newPage();

    await page.setViewport({
      width: cfg?.width || 1920,
      height: cfg?.height || 1080,
      deviceScaleFactor: cfg?.scale || 1,
    });

    await page.setContent(htmlContent);

    const element = await page.$("body");
    const crop = await element.boundingBox();

    const screenshot = await page.screenshot({
      clip: {
        x: 0,
        y: 0,
        width: crop.width,
        height: crop.height,
      },
      ...cfg?.screenshot,
    });

    await page.close();

    return segment.image(screenshot);
  }

  async renderByCanvas(path, params, cfg) {
    const canvas = createCanvas(cfg?.width || 1920, cfg?.height || 1080);
    const ctx = canvas.getContext("2d");

    // 这里可以添加你的canvas绘制逻辑
    // 由于不同插件的绘制逻辑不同，这里只是个基本框架

    const buffer = canvas.toBuffer("image/png");
    return segment.image(buffer);
  }
}
