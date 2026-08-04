import base from "./base.js";
import gsCfg from "./gsCfg.js";
import lodash from "lodash";
import fs from "node:fs";
import common from "../../../lib/common/common.js";
import MysUser from "./mys/MysUser.js";
import MysInfo from "./mys/mysInfo.js";
import NoteUser from "./mys/NoteUser.js";
import Player from "./Player.js";

export default class User extends base {
  constructor(e) {
    super(e);
    this.model = "bingCk";
    /** 绑定的uid */
    this.uidKey = `Yz:genshin:mys:qq-uid:${this.userId}`;

    /** 多角色uid */
    this.allUid = [];
    if (e?.game === "zzz") {
      this.uidKey = `Yz:zzzJson:mys:qq-uid:${this.userId}`;
    } else if (e?.game === "sr" || /星铁|崩坏星穹铁道|铁道|星穹|星轨|\/common\//.test(e?.msg)) {
      this.e.isSr = true;
      /** 绑定的uid */
      this.uidKey = `Yz:srJson:mys:qq-uid:${this.userId}`;
    }
  }

  // 获取当前user实例
  async user() {
    return await MysInfo.getNoteUser(this.e);
  }

  async resetCk() {
    let user = await this.user();
    await user.initCache();
  }

  /** 绑定ck */
  async bing() {
    let user = await this.user();
    let set = gsCfg.getConfig("mys", "set");

    if (!this.e.ck) {
      await this.e.reply(
        `请【私聊】发送米游社cookie，获取教程：\n${set.cookieDoc}`,
      );
      return;
    }

    let ck = this.e.ck.replace(/#|'|"/g, "");
    let param = {};
    ck.split(";").forEach((v) => {
      // 处理分割特殊cookie_token
      let tmp = lodash.trim(v).replace("=", "~").split("~");
      param[tmp[0]] = tmp[1];
    });

    if (!param.cookie_token && !param.cookie_token_v2) {
      await this.e.reply(
        "发送cookie不完整\n请退出米游社【重新登录】，刷新完整cookie",
      );
      return;
    }

    this.ck = `ltoken=${param.ltoken};ltuid=${param.ltuid || param.login_uid};cookie_token=${param.cookie_token || param.cookie_token_v2}; account_id=${param.ltuid || param.login_uid};`;
    if (param.login_ticket) {
      this.ck += ` login_ticket=${param.login_ticket};`;
    }
    if (param.stoken) {
      this.ck += ` stoken=${param.stoken};stuid=${param.stuid || param.ltuid || param.login_uid};`;
    }
    let flagV2 = false;
    if (param.cookie_token_v2 && (param.account_mid_v2 || param.ltmid_v2)) {
      //
      // account_mid_v2 为版本必须带的字段，不带的话会一直提示绑定cookie失败 请重新登录
      flagV2 = true;
      this.ck = `account_mid_v2=${param.account_mid_v2};cookie_token_v2=${param.cookie_token_v2};ltoken_v2=${param.ltoken_v2};ltmid_v2=${param.ltmid_v2};`;
      if (param.login_ticket) {
        this.ck += `login_ticket=${param.login_ticket};`;
      }
      if (param.stoken_v2) {
        this.ck += `stoken_v2=${param.stoken_v2};mid=${param.ltmid_v2};`;
      } else if (param.stoken) {
        this.ck += `stoken=${param.stoken};stuid=${param.stuid || param.ltuid || param.login_uid};`;
      }
    }
    /** 拼接ck */
    this.ltuid = param.ltuid || param.ltmid_v2;

    /** 米游币签到字段 */
    this.login_ticket = param.login_ticket ?? "";

    /** 检查ck是否失效 */
    if (!(await this.checkCk(param))) {
      logger.mark(`绑定cookie错误：${this.checkMsg || "cookie错误"}`);
      await this.e.reply(`绑定cookie失败：${this.checkMsg || "cookie错误"}`);
      return;
    }

    if (flagV2) {
      // 获取米游社通行证id
      let userFullInfo = await this.getUserInfo();
      if (userFullInfo?.data?.user_info) {
        let userInfo = userFullInfo?.data?.user_info;
        this.ltuid = userInfo.uid;
        this.ck = `${this.ck}ltuid=${this.ltuid};`;
      } else {
        logger.mark(`绑定cookie错误：${userFullInfo.message || "cookie错误"}`);
        await this.e.reply(
          `绑定cookie失败：${userFullInfo.message || "cookie错误"}`,
        );
        return;
      }
    }

    logger.mark(`${this.e.logFnc} 检查cookie正常 [uid:${this.uid}]`);

    // 创建 MysUser 实例并保存到数据库（照搬喵喵流程）
    let mys = await MysUser.create(this.ltuid)
    if (mys) {
      let data = {}
      data.ck = this.ck
      data.ltuid = this.ltuid
      mys.setCkData(data)

      /** 拉取米游社角色列表，按游戏写入 MysUser.uids（gs/sr/zzz），保证 #uid 与各游戏功能能读到绑定 */
      let uidRet = await mys.reqMysUid()
      if (uidRet.status !== 0) {
        logger.mark(`绑定cookie错误：${uidRet.msg || "cookie错误"}`)
        mys._delCache()
        return await this.e.reply(`绑定cookie失败：${uidRet.msg || "cookie错误"}`)
      }

      await user.addMysUser(mys)
      await mys.initCache()
      await user.save()
    }

    logger.mark(
      `${this.e.logFnc} 保存cookie成功 [uid:${this.uid}] [ltuid:${this.ltuid}]`,
    );

    let uidMsg = [`绑定cookie成功\n${this.region_name}：${this.uid}`];
    if (!lodash.isEmpty(this.allUid)) {
      this.allUid.forEach((v) => {
        uidMsg.push(`${v.region_name}：${v.uid}`);
      });
    }
    await this.e.reply(uidMsg.join("\n"));
    let msg = "";
    this.region_name += lodash.map(this.allUid, "region_name").join(",");
    if (
      /天空岛|世界树|America Server|Europe Server|Asia Server/.test(
        this.region_name,
      )
    ) {
      msg += "原神模块支持：\n【#体力】查询当前树脂";
      msg += "\n【#签到】米游社原神自动签到";
      msg += "\n【#关闭签到】开启或关闭原神自动签到";
      msg += "\n【#原石】查看原石札记";
      msg += "\n【#原石统计】原石统计数据";
      msg += "\n【#练度统计】技能统计列表";
      msg += "\n【#uid】当前绑定ck uid列表";
      msg += "\n【#ck】检查当前用户ck是否有效";
      msg += "\n【#我的ck】查看当前绑定ck";
      msg += "\n【#删除ck】删除当前绑定ck";
    }
    if (/星穹列车|Server|无名客/.test(this.region_name)) {
      msg += "\n星穹铁道支持：\n功能还在咕咕咕~";
    }
    msg += "\n 支持绑定多个ck";
    msg = await common.makeForwardMsg(
      this.e,
      ["使用命令说明", msg],
      "绑定成功：使用命令说明",
    );

    await this.e.reply(msg);
  }

  /** 检查ck是否可用 */
  async checkCk(param) {
    let res;
    for (let type of ["mys", "hoyolab"]) {
      let roleRes = await this.getGameRoles(type);
      if (roleRes?.retcode === 0) {
        res = roleRes;
        /** 国际服的标记 */
        if (type == "hoyolab" && typeof param.mi18nLang === "string") {
          this.ck += ` mi18nLang=${param.mi18nLang};`;
        }
        break;
      }
      if (roleRes.retcode == -100) {
        this.checkMsg = "该ck已失效，请重新登录获取";
      }
      this.checkMsg = roleRes.message || "error";
    }

    if (!res) return false;

    if (!res.data.list || res.data.list.length <= 0) {
      this.checkMsg = "该账号尚未绑定原神或星穹角色！";
      return false;
    } else {
      res.data.list = res.data.list.filter((v) =>
        ["hk4e_cn", "hkrpg_cn", "nap_cn", "hk4e_global", "hkrpg_global", "nap_global"].includes(
          v.game_biz,
        ),
      );
    }
    //避免同时多个默认展示角色时候只绑定一个
    let is_chosen = false;
    /** 米游社默认展示的角色 */
    for (let val of res.data.list) {
      if (val.is_chosen && !is_chosen) {
        this.uid = val.game_uid;
        this.region_name = val.region_name;
        this.region = val.region;
        is_chosen = true;
      } else {
        this.allUid.push({
          uid: val.game_uid,
          region_name: val.region_name,
          region: val.region,
        });
      }
    }

    if (!this.uid && res.data?.list?.length > 0) {
      this.uid = res.data.list[0].game_uid;
      this.region_name = res.data.list[0].region_name;
      if (this.allUid[0].uid == this.uid) delete this.allUid[0];
    }

    return this.uid;
  }

  async getGameRoles(server = "mys") {
    return await MysUser.getGameRole(this.ck, server);
  }

  // 获取米游社通行证id
  async getUserInfo(server = "mys") {
    return await MysUser.getUserFullInfo(this.ck, server);
  }

  /** 删除绑定ck */
  async delCk(uid = "") {
    let user = await this.user();
    let uids = await user.delCk();
    return `绑定cookie已删除,uid:${uids.join(",")}`;
  }

  /** 绑定uid，若有ck的话优先使用ck-uid */
  async bingUid() {
    let uid = this.e.msg.match(/[1|2|5-9][0-9]{8}/g);
    if (!uid) return;
    uid = uid[0];
    let user = await this.user();
    // 归属校验：防止 mainId 串号把 uid 绑定到主账号上，绑定必须落到当前发送者自己账号
    if (user?.qq && this.e?.user_id && String(user.qq) !== String(this.e.user_id)) {
      logger.mark(`[#绑定uid] 检测到 user 串号(user:${user.qq} != 发送者:${this.e.user_id})，按当前用户重建`)
      user = await NoteUser.create(this.e.user_id)
    }
    await user.addRegUid(uid, this.e);
    return await this.showUid();
  }

  /** #uid */
  async showUid() {
    let user = await this.user()
    // 归属校验兜底：NoteUser.create(e) 里若 redis 存在 mainId 会把 user 指向主账号，
    // 导致把别人的 uid 列表发给当前用户。检测到串号时按当前发送者重建，只显示自己的绑定
    if (user?.qq && this.e?.user_id && String(user.qq) !== String(this.e.user_id)) {
      logger.mark(`[#uid] 检测到 user 串号(user:${user.qq} != 发送者:${this.e.user_id})，按当前用户重建`)
      user = await NoteUser.create(this.e.user_id)
    }
    let uids = [
      { key: "gs", name: "原神" },
      { key: "sr", name: "星穹铁道" },
      { key: "zzz", name: "绝区零" },
    ]
    for (let ds of uids) {
      ds.uidList = user.getUidList(ds.key)
      ds.uid = user.getUid(ds.key)
      for (let uidDs of ds.uidList) {
        let player = Player.create(uidDs.uid, ds.key)
        if (player) {
          uidDs.name = player.name
          uidDs.level = player.level
          let imgs = player?.faceImgs || {}
          uidDs.face = imgs.face
          uidDs.banner = imgs.banner
        }
        // 绝区零：没有角色头像数据时使用默认占位图
        if (ds.key === "zzz") {
          uidDs.zzz_face = !uidDs.face
          uidDs.zzz_banner = !uidDs.banner
          // 无面板数据时尝试从 API 获取
          if (!uidDs.name) {
            // 尝试用绑定 API 获取玩家信息（game_record 的 index 端点可能不存在）
            let mysUser = user.getMysUser("zzz")
            if (mysUser?.ck) {
              let roleRes = await MysUser.getGameRole(mysUser.ck, "mys").catch(() => false)
              if (roleRes?.retcode === 0 && roleRes.data?.list) {
                let zzzRole = roleRes.data.list.find(r => r.game_uid == uidDs.uid)
                if (zzzRole) {
                  uidDs.name = zzzRole.nickname || uidDs.uid
                  uidDs.level = zzzRole.level || "?"
                } else {
                  uidDs.name = uidDs.uid
                  uidDs.level = "?"
                }
              } else {
                uidDs.name = uidDs.uid
                uidDs.level = "?"
              }
            } else {
              uidDs.name = uidDs.uid
              uidDs.level = "?"
            }
          }
        }
      }
    }
    return this.e.reply([
      await this.e.runtime.render("genshin", "html/user/uid-list", { uids }, { retType: "base64" }),
      segment.button(
        [
          { text: "绑定UID", input: "#绑定uid" },
          { text: "切换UID", input: "#uid" },
          { text: "删除UID", input: "#删除uid" },
        ],
        [
          { text: "角色", callback: "#角色" },
          { text: "体力", callback: "#体力" },
          { text: "抽卡", callback: "#抽卡记录" },
        ],
      ),
    ])
  }

  /** 切换uid */
  async toggleUid(index) {
    let user = await this.user();
    let game = this.e.game || "gs";
    let uidList = user.getUidList(game);
    if (index > uidList.length) {
      return await this.e.reply("uid序号输入错误");
    }
    index = Number(index) - 1;
    await user.setMainUid(index, game);
    await user.save();
    return await this.showUid();
  }

  /** 加载旧ck */
  async loadOldData() {
    let file = [
      "./data/MysCookie/NoteCookie.json",
      "./data/NoteCookie/NoteCookie.json",
      "./data/NoteCookie.json",
    ];
    let json = file.find((v) => fs.existsSync(v));
    if (!json) return;

    let list = JSON.parse(fs.readFileSync(json, "utf8"));
    let arr = {};

    logger.mark(logger.green("加载用户ck..."));

    lodash.forEach(list, (ck, qq) => {
      if (ck.qq) qq = ck.qq;

      let isMain = false;
      if (!arr[qq]) {
        arr[qq] = {};
        isMain = true;
      }

      let param = {};
      ck.cookie.split(";").forEach((v) => {
        let tmp = lodash.trim(v).split("=");
        param[tmp[0]] = tmp[1];
      });

      let ltuid = param.ltuid;

      if (!param.cookie_token) return;

      arr[qq][String(ck.uid)] = {
        uid: ck.uid,
        qq,
        ck: ck.cookie,
        ltuid,
        isMain,
        device_id: this.getGuid(),
      };
    });

    lodash.forEach(arr, (ck, qq) => {
      let saveFile = `./data/MysCookie/${qq}.yaml`;
      if (fs.existsSync(saveFile)) return;
      gsCfg.saveBingCk(qq, ck);
    });

    logger.mark(logger.green(`加载用户ck完成：${lodash.size(arr)}个`));

    fs.unlinkSync(json);
  }

  /** 我的ck */
  async myCk() {
    let user = await this.user();
    if (!user.hasCk) {
      this.e.reply("当前尚未绑定cookie");
    }
    let ck = user.mainCk;

    if (!lodash.isEmpty(ck)) {
      await this.e.reply(`当前绑定cookie\nuid：${ck.uid}`);
      await this.e.reply(ck.ck);
    }
  }

  async checkCkStatus() {
    let user = await this.user();
    if (!user.hasCk) {
      await this.e.reply(
        `\n未绑定CK，当前绑定uid：${user.uid || "无"}`,
        false,
        { at: true },
      );
      return true;
    }
    let uid = user.uid * 1;
    let uids = user.ckUids;

    let checkRet = await user.checkCk();
    let cks = [];
    lodash.forEach(checkRet, (ds, idx) => {
      let tmp = [
        `\n#${idx + 1}: [CK:${ds.ltuid}] - 【${ds.status === 0 ? "正常" : "失效"}】`,
      ];
      if (ds.uids && ds.uids.length > 0) {
        let dsUids = [];
        lodash.forEach(ds.uids, (u) => {
          dsUids.push(u * 1 === uid ? `☑${u}` : u);
        });
        tmp.push(`绑定UID: [ ${dsUids.join(", ")} ]`);
      }
      if (ds.status !== 0) {
        tmp.push(ds.msg);
      }
      cks.push(tmp.join("\n"));
    });
    if (uids.length > 1) {
      cks.push(`当前生效uid：${uid}\n通过【#uid】命令可查看并切换UID`);
    }

    await this.e.reply(cks.join("\n----\n"), false, { at: true });
  }

  getGuid() {
    function S4() {
      return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
    }

    return (
      S4() +
      S4() +
      "-" +
      S4() +
      "-" +
      S4() +
      "-" +
      S4() +
      "-" +
      S4() +
      S4() +
      S4()
    );
  }

  async userAdmin() {
    this.model = "userAdmin";
    await MysInfo.initCache();
    let stat = await MysUser.getStatData();
    return {
      saveId: "user-admin",
      ...stat,
      _plugin: "genshin",
      ...this.screenData,
    };
  }
}
