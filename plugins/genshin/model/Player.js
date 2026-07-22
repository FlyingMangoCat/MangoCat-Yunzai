/**
 * 用户数据文件
 * 数据存储在/data/UserData/${uid}.json 下
 * 兼容处理面板户数及Mys数据
 *
 * 参照喵喵 plugin 的 Player 实现
 */
import lodash from 'lodash'
import fs from 'node:fs'
import path from 'node:path'
import Base from './MiaoBase.js'
import { Character } from '#liulian.models'

const playerDataDir = path.join(process.cwd(), 'data', 'PlayerData')

export default class Player extends Base {
  constructor (uid, game = 'gs') {
    super()
    uid = uid?._mys?.uid || uid?.uid || uid
    if (!uid) {
      return false
    }
    let cacheObj = this._getCache(`player:${game}:${uid}`)
    if (cacheObj) {
      return cacheObj
    }
    this.uid = uid
    this.game = game
    this.reload()
    return this._cache(100)
  }

  get hasProfile () {
    let ret = false
    this.forEachAvatar((avatar) => {
      if (avatar.isProfile) {
        ret = true
        return false
      }
    })
    return ret
  }

  get _file () {
    return path.join(playerDataDir, this.game, `${this.uid}.json`)
  }

  // 玩家头像
  get faceImgs () {
    let char
    if (this.isGs && this.face) {
      char = Character.get(this.face)
    }
    if (!char) {
      let charId = lodash.keys(this._avatars)[0]
      if (charId) {
        char = Character.get(charId)
      }
    }
    let imgs = char?.imgs || {}
    return {
      face: imgs.face || '/common/item/face.webp',
      banner: imgs.banner || `/meta-${this.game}/character/common/imgs/banner.webp`
    }
  }

  static create (e, game = 'gs') {
    if (e?._mys?.uid || e.uid) {
      let player = new Player(e?._mys?.uid || e.uid, (game === 'sr' || e.isSr) ? 'sr' : 'gs')
      player.e = e
      return player
    } else {
      return new Player(e, game)
    }
  }

  // 获取面板更新服务名
  static getProfileServName (uid, game = 'gs') {
    return null
  }

  static delByUid (uid, game = 'gs') {
    let player = Player.create(uid, game)
    if (player) {
      player.del()
    }
  }

  /**
   * 重新加载json文件
   * 从 bot 根目录 data/PlayerData 读取
   */
  reload () {
    let data = {}
    if (fs.existsSync(this._file)) {
      try {
        data = JSON.parse(fs.readFileSync(this._file, 'utf8'))
      } catch (e) {
        // ignore
      }
    }
    this.setBasicData(data)
  }

  // 设置基础数据
  setBasicData (ds) {
    if (!ds) return
    this.name = ds.name || this.name || ''
    this.level = ds.level || this.level || ''
    this.face = ds.face || this.face || ''
    this.word = ds.word || this.word || ''
    this.card = ds.card || this.card || ''
    this.sign = ds.sign || this.sign || ''
    this._avatars = ds.avatars || this._avatars || {}
  }

  del () {
    this._delCache()
  }
}