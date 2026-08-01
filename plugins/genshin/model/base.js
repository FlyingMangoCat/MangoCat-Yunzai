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
        /** 星铁头部背景图（黑天鹅立绘） */
        headImg: `../../liulian-plugin/resources/星铁/splash/黑天鹅.webp`,
        game: "sr",
      };
    }
    return {
      ...baseData,
      tplFile: `./plugins/genshin/resources/html/${this.model}/${this.model}.html`,
      /** 绝对路径 */
      pluResPath: `${this._path}/plugins/genshin/resources/`,
      srtempFile: "",
      /** 原神头部背景图（闲云立绘） */
      headImg: `../../liulian-plugin/resources/genshin/logo/splash/闲云.png`,
      game: "gs",
    };
  }
}