import fs from "node:fs"

export default class base {
  constructor(e = {}) {
    this.e = e;
    this.userId = e?.user_id;
    this.model = "genshin";
    this._path = process.cwd().replace(/\\/g, "/");
  }

  get prefix() {
    return `Yz:genshin:${this.model}:`;
  }

  /**
   * 截图默认数据
   * @param saveId html保存id
   * @param tplFile 模板html路径
   * @param pluResPath 插件资源路径
   */
  get screenData() {
    const layoutPath = `${this._path}/plugins/genshin/resources/html/layout/`;
    const baseData = {
      saveId: this.userId,
      cwd: this._path,
      genshinLayout: layoutPath + "genshin.html",
      defaultLayout: layoutPath + "default.html",
    };
    if (this.e?.isSr) {
      return {
        ...baseData,
        tplFile: `./plugins/genshin/resources/StarRail/html/${this.model}/${this.model}.html`,
        /** 绝对路径 */
        pluResPath: `${this._path}/plugins/genshin/resources/StarRail/`,
        srtempFile: "StarRail/",
        /** 星铁头部背景图（随机立绘） */
        headImg: this.randSplash("sr"),
        game: "sr",
      };
    }
    return {
      ...baseData,
      tplFile: `./plugins/genshin/resources/html/${this.model}/${this.model}.html`,
      /** 绝对路径 */
      pluResPath: `${this._path}/plugins/genshin/resources/`,
      srtempFile: "",
      /** 原神头部背景图（随机立绘） */
      headImg: this.randSplash("gs"),
      game: "gs",
    };
  }

  /** 随机取一张立绘图路径 */
  randSplash(game = "gs") {
    try {
      const dir = game === "sr"
        ? `${this._path}/plugins/liulian-plugin/resources/星铁/splash`
        : `${this._path}/plugins/liulian-plugin/resources/genshin/logo/splash`;
      const files = fs.readdirSync(dir).filter(f => /\.(png|webp|jpg)$/i.test(f));
      if (!files.length) return "";
      const pick = files[Math.floor(Math.random() * files.length)];
      const rel = game === "sr"
        ? `../../liulian-plugin/resources/星铁/splash/${pick}`
        : `../../liulian-plugin/resources/genshin/logo/splash/${pick}`;
      return rel;
    } catch (e) {
      return "";
    }
  }
}