/**
 * Bot实际User用户类
 * 主键QQ
 *
 *  User可以注册UID，通过 getRegUid / setRegUid
 *  一个User可以绑定多个MysUser CK，绑定MysUser
 */
import BaseModel from "./BaseModel.js"
import lodash from "lodash"
import MysUser from "./MysUser.js"
import gsCfg from "../gsCfg.js"
import { UserDB, UserGameDB } from "../db/index.js"
import MysUtil from "./MysUtil.js"

export default class NoteUser extends BaseModel {
  constructor(qq, data = null) {
    super();
    // 检查实例缓存
    let cacheObj = this._getThis("user", qq);
    if (cacheObj) {
      return cacheObj;
    }
    this.qq = qq;
    this.mysUsers = {};
    if (data) {
      this.ckData = this.ckData || {};
      for (let uid in data) {
        let ck = data[uid];
        if (uid && ck.uid) {
          this.ckData[uid] = ck;
        }
      }
    } else if (!this.ckData) {
      this._getCkData();
    }
    // 缓存实例
    return this._cacheThis();
  }

  // 初始化 user
  /**
   * 创建NoteUser实例
   * @param qq NoterUser对应id（qq）
   * * 若传入e对象则会识别e.user_id，并将user对象添加至e.user
   * @param data 用户对应MysCookie数据，为空则自动读取
   * @returns {Promise<NoteUser|*>}
   */
  static async create(qq, data = null) {
    // 兼容处理传入e
    if (qq && qq.user_id) {
      let e = qq;
      let user = await NoteUser.create(e.user_id);
      e.user = user;
      return user;
    }
    let user = new NoteUser(qq, data);
    // 尝试初始化数据库
    await user.initDB();
    // 检查绑定uid (regUid)
    await user.getRegUid();
    // 传入data则使用，否则读取
    return user;
  }

  static async forEach(fn) {
    // 先尝试数据库遍历
    try {
      let dbs = await UserDB.findAll()
      for (let db of dbs) {
        let user = await NoteUser.create(db.id, db)
        if (user && fn) {
          if ((await fn(user)) === false) break
        }
      }
      return
    } catch (e) {
      // 数据库不可用时，降级到文件遍历
    }
    // 文件式遍历（降级）
    let res = await gsCfg.getBingCk();
    for (let qq in res.noteCk) {
      let cks = res.noteCk[qq];
      if (!lodash.isEmpty(cks)) {
        let user = await NoteUser.create(qq, cks);
        if (user && fn) {
          if ((await fn(user)) === false) {
            break;
          }
        }
      }
    }
  }

  // 初始化数据库
  async initDB(db = false) {
    if (this.db && !db) return
    if (db && db !== true) {
      this.db = db
    } else {
      this.db = await UserDB.find(this.qq, "qq")
    }
    await this.initMysUser()
    this._games = this.db.games
    await this.save()
  }

  // 初始化MysUser对象
  async initMysUser() {
    let ltuids = this.db?.ltuids || ""
    this.mysUsers = {}
    for (let ltuid of ltuids.split(",")) {
      if (!ltuid) continue
      let mys = await MysUser.create(ltuid)
      if (mys) {
        this.mysUsers[ltuid] = mys
      }
    }
  }

  // 保存到数据库
  async save() {
    await this.db.saveDB(this)
  }

  getUidMapList(game = "gs", type = "all") {
    game = MysUtil.getGameKey(game)
    if (this._map?.[game]?.[type]) {
      return this._map[game][type]
    }
    let uidMap = {}
    let uidList = []
    lodash.forEach(this.mysUsers, mys => {
      if (!mys) return
      lodash.forEach(mys.uids?.[game] || [], uid => {
        uid = uid + ""
        if (uid && !uidMap[uid]) {
          uidMap[uid] = mys.getUidData(uid, game)
          uidList.push(uidMap[uid])
        }
      })
    })
    // 从游戏数据中补充注册的UID
    if (type === "all") {
      let gameDs = this.getGameDs(game)
      lodash.forEach(gameDs.data, ds => {
        if (ds.uid && !uidMap[ds.uid]) {
          uidMap[ds.uid] = ds
          uidList.push(ds)
        }
      })
      // 补充主UID（兼容 data 为空但 uid 已设置的情况）
      if (gameDs.uid && !uidMap[gameDs.uid]) {
        uidMap[gameDs.uid] = { uid: gameDs.uid, type: "reg" }
        uidList.push(uidMap[gameDs.uid])
      }
    }
    this._map = this._map || {}
    this._map[game] = this._map[game] || {}
    this._map[game][type] = { map: uidMap, list: uidList }
    return this._map[game][type]
  }

  /**
   * 获取当前用户uid
   * 如果为绑定用户，优先获取ck对应uid，否则获取绑定uid
   */
  get uid() {
    return this.getUid()
  }

  /**
   * 当前用户是否具备CK
   */
  get hasCk() {
    return (this.ckData && !lodash.isEmpty(this.ckData)) || !lodash.isEmpty(this.mysUsers)
  }

  /**
   * 获取绑定CK的UID列表，如未绑定CK则返回空数组
   */
  get ckUids() {
    if (!this.hasCk) {
      return [];
    }
    return lodash.map(this.ckData, "uid");
  }

  /**
   * 获取当前生效CK
   *
   * 返回isMain的uid，没有的话返回首位
   */
  get mainCk() {
    // 优先查数据库
    if (!lodash.isEmpty(this.mysUsers)) {
      let mys = lodash.values(this.mysUsers)[0]
      if (mys) return { ltuid: mys.ltuid, uid: mys.getUids("gs")?.[0] || "", ck: mys.ck }
    }
    // 降级查文件
    if (this.ckData && !lodash.isEmpty(this.ckData)) {
      return (
        lodash.filter(this.ckData, (ck) => ck.isMain)[0] ||
        lodash.values(this.ckData)[0]
      );
    }
    return false;
  }

  /**
   * 获取当前用户的所有ck
   * @returns { {ltuid:{ckData, ck, uids}} }
   */
  get cks() {
    let cks = {};
    // 优先查数据库
    lodash.forEach(this.mysUsers, (mys) => {
      if (mys && mys.ltuid && mys.ck) {
        cks[mys.ltuid] = {
          ckData: { ltuid: mys.ltuid, ck: mys.ck, uid: mys.getUids("gs")?.[0] || "" },
          ck: mys.ck,
          uids: mys.getUids("gs") || [],
        }
      }
    })
    if (!lodash.isEmpty(cks)) return cks
    // 降级查文件
    if (!this.ckData) return cks;
    for (let uid in this.ckData) {
      let ck = this.ckData[uid];
      if (ck && ck.ltuid && ck.uid) {
        cks[ck.ltuid] = cks[ck.ltuid] || {
          ckData: ck,
          ck: ck.ck,
          uids: [],
        };
        cks[ck.ltuid].uids.push(ck.uid);
      }
    }
    return cks;
  }

  /**
   * 获取当前用户的绑定UID
   * 主要供内部调用，建议使用 user.uid 获取用户uid
   * @returns {Promise<*>}
   */
  async getRegUid(redisKey = `Yz:genshin:mys:qq-uid:${this.qq}`) {
    let uid = await redis.get(redisKey);
    if (uid) {
      await redis.setEx(redisKey, 3600 * 24 * 30, uid);
    }
    this._regUid = uid;
    return this._regUid;
  }

  /**
   * 设置当前用户的绑定uid
   * @param uid 要绑定的uid
   * @param force 若已存在绑定uid关系是否强制更新
   */
  async setRegUid(uid = "", force = false) {
    let redisKey = `Yz:genshin:mys:qq-uid:${this.qq}`;
    if (uid && /[1|2|5-9][0-9]{8}/.test(uid)) {
      uid = String(uid);
      const oldUid = await this.getRegUid();
      // force true、不存在绑定UID，UID一致时存储并更新有效期
      if (force || !oldUid || oldUid === uid) {
        await redis.setEx(redisKey, 3600 * 24 * 30, uid);
      }
      this._regUid = uid;
      return String(this._regUid) || "";
    }
    return "";
  }

  /** 获取指定游戏uid */
  getUid(game = "gs") {
    game = MysUtil.getGameKey(game)
    let ds = this._games?.[game]
    if (!ds?.uid) {
      this.setMainUid("", game)
    }
    return this._games?.[game]?.uid || ""
  }

  /** 获取游戏数据对象 */
  getGameDs(game = "gs") {
    game = MysUtil.getGameKey(game)
    if (!this._games[game]) {
      this._games[game] = { uid: "", data: {} }
    }
    return this._games[game]
  }

  /** 自动注册/绑定uid */
  async autoRegUid(uid, game = "gs") {
    if (this.getUid(game)) return uid
    game = MysUtil.getGameKey(game)
    uid = uid + ""
    let gameDs = this._games[game]
    gameDs.data[uid] = { uid, type: "reg" }
    gameDs.uid = uid
    this._map = false
    await this.save()
    return await this.setRegUid(uid, true)
  }

  /** 添加注册UID（保存到数据库） */
  addRegUid(uid, game = "gs", save = true) {
    game = this.gameKey(game)
    uid = uid + ""
    let gameDs = this.getGameDs(game)
    gameDs.data[uid] = { uid, type: "reg" }
    this._map = false
    this.setMainUid(uid, game, false)
    if (save) {
      this.save()
    }
  }

  /** 获取uid列表 */
  getUidList(game = "gs") {
    return this.getUidMapList(game, "all").list
  }

  /** 获取uid数据 */
  getUidData(uid, game = "gs") {
    if (!uid) uid = this.getUid(game)
    return this.getUidMapList(game, "all").map[uid]
  }

  /**
   * 切换绑定CK生效的UID
   * @param uid 要切换的UID
   */
  async setMainUid(uid = "") {
    // 兼容传入index
    if (uid * 1 <= this.ckUids.length) uid = this.ckUids[uid];
    // 非法值，以及未传入时使用当前或首个有效uid
    uid = (uid || this.uid) * 1;
    // 设置主uid
    lodash.forEach(this.ckData, (ck) => {
      ck.isMain = ck.uid * 1 === uid * 1;
    });
    // 保存CK数据
    this._saveCkData();
    await this.setRegUid(uid, true);
  }

  /**
   * 初始化或重置 当前用户缓存
   */
  async initCache() {
    // 刷新绑定CK的缓存
    let count = 0;
    let cks = this.cks;
    for (let ltuid in cks) {
      let { ckData, uids } = cks[ltuid];
      let mysUser = await MysUser.create(ckData);
      for (let uid of uids) {
        mysUser.addUid(uid);
      }
      if (mysUser && (await mysUser.initCache(this))) {
        count++;
      }
    }
    return count;
  }

  /**
   * 为当前用户增加CK
   * @param cks 绑定的ck
   */
  async addCk(cks) {
    let ckData = this.ckData;
    lodash.forEach(cks, (ck, uid) => {
      ckData[uid] = ck;
    });
    this._saveCkData();
    await this.initCache();
  }

  /**
   * 删除当前用户绑定CK
   * @param ltuid 根据ltuid删除，未传入则删除当前生效uid对应ltuid
   * @param needRefreshCache 是否需要刷新cache，默认刷新
   */
  async delCk(ltuid = "", needRefreshCache = true) {
    if (!ltuid) {
      ltuid = this.mainCk.ltuid;
    }
    let ret = [];
    ltuid = ltuid * 1;
    let ckData = this.ckData;
    for (let uid in ckData) {
      let ck = ckData[uid];
      if (ltuid && ck.ltuid * 1 === ltuid) {
        ret.push(uid);
        delete ckData[uid];
      }
    }
    // 刷新主ck并保存ckData
    await this.setMainUid();

    // 刷新MysUser缓存
    if (needRefreshCache) {
      let ckUser = await MysUser.create(ltuid);
      if (ckUser) {
        await ckUser.del(this);
      }
    }
    return ret;
  }

  /**
   * 检查当前用户绑定的CK状态
   */
  async checkCk() {
    // TODO:待完善文案
    let cks = this.cks;
    let ret = [];
    for (let ltuid in cks) {
      let ck = cks[ltuid].ck;
      if (!ltuid || !ck) {
        continue;
      }
      let checkRet = await MysUser.checkCkStatus(ck);
      // TODO: 若checkRet中返回了不同的uid，进行CK保存更新
      // 失效
      let mysUser = await MysUser.create(ck);
      if (mysUser) {
        let status = checkRet.status;
        if (status === 0 || status === 1) {
          // status为1时无法查询天赋，但仍可查询角色，保留CK
          await mysUser.initCache();
        } else if (status === 2) {
          // status为2时无法查询角色，删除ck cache
          // 因仍能查询体力，故保留ck记录不直接删除
          await mysUser.del();
        } else if (status === 3) {
          // status为3时CK完全失效，用户删除此CK
          await this.delCk(ltuid);
        }
      }
      ret.push({
        ltuid,
        ...checkRet,
      });
    }
    return ret;
  }

  // 内部方法：读取CK数据
  _getCkData() {
    this.ckData = gsCfg.getBingCkSingle(this.qq);
    return this.ckData;
  }

  // 内部方法：写入CK数据
  _saveCkData() {
    gsCfg.saveBingCk(this.qq, this.ckData);
  }
}