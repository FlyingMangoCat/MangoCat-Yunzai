import plugin from "../../../lib/plugins/plugin.js";
import fs from "node:fs";
import lodash from "lodash";
import crypto from "node:crypto";
import fetch from "node-fetch";
import gsCfg from "../model/gsCfg.js";
import User from "../model/user.js";
import { MysUserDB } from "../model/db/index.js";

// 用 stoken 换新 cookie_token 的接口(与扫码登录同款 passport 通道)
const API_GET_COOKIE = "https://passport-api.mihoyo.com/account/auth/api/getCookieAccountInfoBySToken";

function randomString(n) {
  return lodash
    .sampleSize(
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      n,
    )
    .join("");
}

function md5(data) {
  return crypto.createHash("md5").update(data).digest("hex");
}

function ds(data) {
  const t = Math.floor(Date.now() / 1000);
  const r = randomString(6);
  const h = md5(`salt=JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS&t=${t}&r=${r}&b=${data}&q=`);
  return `${t},${r},${h}`;
}

// passport 通用请求(Hyperion 风格,与扫码登录一致)
function passportRequest(url, cookie) {
  return fetch(url, {
    headers: {
      "x-rpc-app_version": "2.104.0",
      DS: ds(""),
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-rpc-game_biz": "bbs_cn",
      "x-rpc-sys_version": "12",
      "x-rpc-device_id": randomString(16),
      "x-rpc-device_fp": randomString(13),
      "x-rpc-device_name": randomString(16),
      "x-rpc-device_model": randomString(16),
      "x-rpc-app_id": "bll8iq97cem8",
      "x-rpc-client_type": "2",
      "User-Agent": "Hyperion/550 CFNetwork/3860.500.112 Darwin/25.4.0",
      Cookie: cookie,
    },
  });
}

export class user extends plugin {
  constructor(e) {
    super({
      name: "用户绑定",
      dsc: "米游社ck绑定，游戏uid绑定",
      event: "message",
      priority: 300,
      rule: [
        {
          reg: "^#*(体力|ck|cookie)帮助",
          fnc: "ckHelp",
        },
        {
          reg: "^(ck|cookie|js)代码$",
          fnc: "ckCode",
        },
        {
          reg: "^#绑定(cookie|ck)$",
          fnc: "bingCk",
        },
        {
          reg: "(.*)_MHYUUID(.*)",
          event: "message.private",
          fnc: "noLogin",
        },
        {
          reg: "^#?我的(ck|cookie)$",
          event: "message",
          fnc: "myCk",
        },
        {
          reg: "^#?删除(ck|cookie)$",
          fnc: "delCk",
        },
        {
          reg: "^#*(刷新|更新)(ck|cookie)$",
          fnc: "refreshCk",
        },
        {
          reg: "^#绑定(uid|UID)?(\\s)*[1-9][0-9]{8,9}$",
          fnc: "bingUid",
        },
        {
          reg: "^#(原神|星铁|绝区零)?(我的)?(uid|UID)[0-9]{0,2}$",
          fnc: "showUid",
        },
        {
          reg: "^#\\s*(检查|我的)*ck(状态)*$",
          fnc: "checkCkStatus",
        },
      ],
    });
    this.User = new User(e);
  }

  async init() {
    let file = "./data/MysCookie";
    if (!fs.existsSync(file)) {
      fs.mkdirSync(file);
    }
    /** 加载旧的绑定ck json */
    this.loadOldData();
  }

  /** 接受到消息都会执行一次 */
  accept() {
    if (!this.e.msg) return;
    // 由于手机端米游社网页可能获取不到ltuid 可以尝试在通行证页面获取login_uid
    if (
      /(ltoken|ltoken_v2)/.test(this.e.msg) &&
      /(ltuid|login_uid|ltmid_v2)/.test(this.e.msg)
    ) {
      if (this.e.isGroup) {
        this.reply("请私聊发送cookie", false, { at: true });
        return true;
      }
      this.e.ck = this.e.msg;
      this.e.msg = "#绑定cookie";
      return true;
    }

    if (this.e.msg == "#绑定uid") {
      this.setContext("saveUid");
      this.reply("请发送绑定的uid", false, { at: true });
      return true;
    }

    if (/^#?星铁绑定uid$/i.test(this.e.msg)) {
      this.setContext("saveSrUid");
      this.reply("请发送绑定的星铁uid", false, { at: true });
      return true;
    }

    if (/^#?绝区零绑定uid$/i.test(this.e.msg)) {
      this.setContext("saveZzzUid");
      this.reply("请发送绑定的绝区零uid", false, { at: true });
      return true;
    }
  }

  /** 绑定uid */
  saveUid() {
    if (!this.e.msg) return;
    let uid = this.e.msg.match(/[1|2|5-9][0-9]{8}/g);
    if (!uid) {
      this.reply("uid输入错误", false, { at: true });
      return;
    }
    this.e.msg = "#绑定" + this.e.msg;
    this.bingUid();
    this.finish("saveUid");
  }

  /** 绑定星铁uid */
  saveSrUid() {
    if (!this.e.msg) return;
    let uid = this.e.msg.match(/[1|2|5-9][0-9]{8}/g);
    if (!uid) {
      this.reply("星铁UID输入错误", false, { at: true });
      return;
    }
    this.e.isSr = true;
    this.e.game = "sr";
    this.e.msg = "#星铁绑定" + this.e.msg;
    this.bingUid();
    this.finish("saveSrUid");
  }

  /** 绑定绝区零uid */
  saveZzzUid() {
    if (!this.e.msg) return;
    let uid = this.e.msg.match(/[1-9][0-9]{8,9}/g);
    if (!uid) {
      this.reply("绝区零UID输入错误", false, { at: true });
      return;
    }
    this.e.isSr = false;
    this.e.game = "zzz";
    this.e.msg = "#绝区零绑定" + this.e.msg;
    this.bingUid();
    this.finish("saveZzzUid");
  }

  /** 未登录ck */
  async noLogin() {
    this.reply(
      "绑定cookie失败\n请先【登录米游社】或【登录通行证】再获取cookie",
    );
  }

  /** #ck代码 */
  async ckCode() {
    await this.reply("javascript:(()=>{prompt('',document.cookie)})();");
  }

  /** ck帮助 */
  async ckHelp() {
    let set = gsCfg.getConfig("mys", "set");
    await this.reply(
      `Cookie绑定配置教程：${set.cookieDoc}\n获取cookie后【私聊发送】进行绑定`,
    );
  }

  /** 绑定ck */
  async bingCk() {
    let set = gsCfg.getConfig("mys", "set");

    if (!this.e.ck) {
      await this.reply(
        `请【私聊】发送米游社cookie，获取教程：\n${set.cookieDoc}`,
      );
      return;
    }

    await this.User.bing();
  }

  /** 删除ck */
  async delCk() {
    let msg = await this.User.delCk();
    await this.reply(msg);
  }

  /** 绑定uid */
  async bingUid() {
    await this.User.bingUid();
  }

  /** #uid */
  async showUid() {
    let index = this.e.msg.match(/[0-9]{1,2}/g);
    if (index && index[0]) {
      await this.User.toggleUid(index[0]);
    } else {
      await this.User.showUid();
    }
  }

  /** 我的ck */
  async myCk() {
    if (this.e.isGroup) {
      await this.reply("请私聊查看");
      return;
    }
    await this.User.myCk();
  }

  /** 加载旧的绑定ck json */
  loadOldData() {
    this.User.loadOldData();
  }

  /** 检查用户CK状态 **/
  async checkCkStatus() {
    await this.User.checkCkStatus();
  }

  /** 刷新ck:用 stoken 换新 cookie_token 后重新绑定 */
  async refreshCk() {
    let user = await this.User.user();
    if (!user.hasCk) {
      await this.reply("未绑定ck,请先发送cookie绑定或使用#扫码登录", false, { at: true });
      return;
    }

    let refreshed = 0;
    let failed = [];
    for (let ltuid in user.mysUsers) {
      let mys = user.mysUsers[ltuid];
      if (!mys?.ltuid) continue;

      // stoken 优先从 MysUserDB 存档读取
      let stokenCookie = "";
      try {
        const mysDb = await MysUserDB.find(Number(ltuid));
        if (mysDb?.stoken) stokenCookie = mysDb.stoken;
      } catch (err) {
        logger.error(`[刷新ck] 读取stoken存档异常 ltuid:${ltuid}`, err);
      }
      // 存档没有则从 ck 解析
      if (!stokenCookie) {
        let param = {};
        String(mys.ck || "").split(";").forEach((v) => {
          let tmp = lodash.trim(v).replace("=", "~").split("~");
          param[tmp[0]] = tmp[1];
        });
        if (param.stoken || param.stoken_v2) {
          stokenCookie = `stoken=${param.stoken || param.stoken_v2};stuid=${param.stuid || ltuid};mid=${param.mid || ""}`;
        }
      }
      if (!stokenCookie) {
        failed.push(`ltuid:${ltuid} 无stoken,无法刷新`);
        continue;
      }

      // 从 stokenCookie 提取 stoken/stuid/mid
      let sParam = {};
      stokenCookie.split(";").forEach((v) => {
        let tmp = lodash.trim(v).replace("=", "~").split("~");
        sParam[tmp[0]] = tmp[1];
      });
      let stoken = sParam.stoken;
      let stuid = sParam.stuid || ltuid;
      let mid = sParam.mid || "";

      // stoken 换新 cookie_token
      let cookieToken = "";
      try {
        let url = `${API_GET_COOKIE}?stoken=${stoken}&uid=${stuid}` + (mid ? `&mid=${mid}` : "");
        let res = await (await passportRequest(url, stokenCookie)).json();
        logger.mark(`[刷新ck] 换cookie_token ltuid:${ltuid} retcode:${res.retcode}`);
        if (res.retcode === 0 && res.data?.cookie_token) {
          cookieToken = res.data.cookie_token;
        } else {
          failed.push(`ltuid:${ltuid} ${res.message || "换取失败"}`);
          continue;
        }
      } catch (err) {
        logger.error(`[刷新ck] 请求异常 ltuid:${ltuid}`, err);
        failed.push(`ltuid:${ltuid} 请求异常`);
        continue;
      }

      // 拼新 ck 走本体绑定流程(ltoken 用 stoken 代位,与扫码登录一致)
      this.e.ck = [
        `ltoken=${stoken}`,
        `ltuid=${stuid}`,
        `cookie_token=${cookieToken}`,
        `account_id=${stuid}`,
        `stoken=${stoken}`,
        `stuid=${stuid}`,
        mid ? `mid=${mid}` : "",
      ].filter(Boolean).join(";");

      try {
        await this.User.bing();
        refreshed++;
      } catch (err) {
        logger.error(`[刷新ck] 绑定异常 ltuid:${ltuid}`, err);
        failed.push(`ltuid:${ltuid} 绑定异常`);
      }
    }

    let msg = [];
    if (refreshed > 0) msg.push(`已刷新 ${refreshed} 个ck`);
    if (failed.length > 0) msg.push(`失败:\n${failed.join("\n")}`);
    if (msg.length === 0) msg.push("没有可刷新的ck");
    await this.reply(msg.join("\n"), false, { at: true });
  }
}
