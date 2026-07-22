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
import { zzzroleId, roleId, starroleId } from '../../liulian-plugin/config/roleId.js'

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
      // 每次获取都重新加载数据，确保面板更新后数据同步
      cacheObj.reload()
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
    let avatarName = ''
    let avatarId = ''
    if (this.face) avatarId = this.face
    // 用角色ID查对应角色表拿官方名称
    let roleMap = this.game === 'zzz' ? zzzroleId : this.game === 'sr' ? starroleId : roleId
    let roleNames = roleMap[avatarId]
    // this.face 可能是角色名（非数字ID）导致匹配失败，回退到 _avatars 取角色ID
    if (!roleNames) {
      if (lodash.isArray(this._avatars)) {
        if (this._avatars.length > 0) avatarId = this._avatars[0].id || this._avatars[0].avatarId || ''
      } else {
        let keys = lodash.keys(this._avatars)
        if (keys.length > 0) avatarId = keys[0]
      }
      roleNames = roleMap[avatarId]
    }
    if (roleNames && roleNames.length > 0) {
      avatarName = roleNames[0]
    } else {
      // roleMap 匹配失败时直接从 _avatars 取角色名
      if (lodash.isArray(this._avatars) && this._avatars.length > 0) {
        avatarName = this._avatars[0].name || ''
      } else {
        let keys = lodash.keys(this._avatars)
        if (keys.length > 0) {
          let first = this._avatars[keys[0]]
          avatarName = first.name || first.avatarName || ''
        }
      }
    }
    if (this.game === 'zzz') {
      return {
        face: avatarName ? `../../liulian-plugin/resources/zzz/gacha/${avatarName}.png` : '/common/item/face.webp',
        banner: '/ZZZero/img/other/banner.png'
      }
    }
    if (this.game === 'sr') {
      let cwd = process.cwd().replace(/\\/g, '/')
      let relPath = `../../liulian-plugin/resources/星铁/role/${avatarName}`
      if (avatarName && fs.existsSync(`${cwd}/plugins/liulian-plugin/resources/星铁/role/${avatarName}.webp`)) {
        return { face: `${relPath}.webp`, banner: `/meta-${this.game}/character/common/imgs/banner.webp` }
      }
      if (avatarName && fs.existsSync(`${cwd}/plugins/liulian-plugin/resources/星铁/role/${avatarName}.png`)) {
        return { face: `${relPath}.png`, banner: `/meta-${this.game}/character/common/imgs/banner.webp` }
      }
      return { face: '/common/item/face.webp', banner: `/meta-${this.game}/character/common/imgs/banner.webp` }
    }
    return {
      face: avatarName ? `../../liulian-plugin/resources/genshin/logo/role/${avatarName}.png` : '/common/item/face.webp',
      banner: `/meta-${this.game}/character/common/imgs/banner.webp`
    }
  }

  static create (e, game = 'gs') {
    if (e?._mys?.uid || e.uid) {
      let targetGame = e?.game || (e.isSr ? 'sr' : game)
      let player = new Player(e?._mys?.uid || e.uid, targetGame)
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