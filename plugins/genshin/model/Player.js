/**
 * Player 类
 * 提供游戏内玩家信息查询
 * 参照喵喵 plugin 的 Player 实现
 */
export default class Player {
  constructor(uid, game = "gs") {
    this.uid = uid
    this.game = game
    this._avatars = {}
    this.face = ""
  }

  get isGs() {
    return this.game === "gs"
  }

  static create(uid, game = "gs") {
    return new Player(uid, game)
  }

  get name() {
    return ""
  }

  get level() {
    return ""
  }

  get faceImgs() {
    return {
      face: "/common/item/face.webp",
      banner: `/meta-${this.game}/character/common/imgs/banner.webp`
    }
  }
}