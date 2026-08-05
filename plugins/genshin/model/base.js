import { Version } from "../components/index.js";

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
      yzName: "MangoCat-Yunzai",
      yzVersion: `v${Version.yunzai}`,
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
        /** 星铁头部背景图（名片） */
        headImg: `img/worldcard/星穹列车.png`,
        game: "sr",
      };
    }
    return {
      ...baseData,
      tplFile: `./plugins/genshin/resources/html/${this.model}/${this.model}.html`,
      /** 绝对路径 */
      pluResPath: `${this._path}/plugins/genshin/resources/`,
      srtempFile: "",
      /** 原神头部背景图（名片） */
      headImg: `img/namecard/甘雨.png`,
      game: "gs",
    };
  }
}