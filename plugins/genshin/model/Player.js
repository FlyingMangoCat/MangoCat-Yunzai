/**
 * Player 类
 * 提供游戏内玩家信息查询
 * 参照喵喵 plugin 的 Player 实现，简化版
 */
import MysApi from "./mys/mysApi.js"

export default class Player {
  constructor(uid, game = "gs") {
    this.uid = uid
    this.game = game
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
    return {}
  }
}