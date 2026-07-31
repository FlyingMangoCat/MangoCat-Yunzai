import plugin from "../../../lib/plugins/plugin.js";
import QR from "qrcode";
import lodash from "lodash";
import fetch from "node-fetch";
import User from "../model/user.js";
import MysUser from "../model/mys/MysUser.js";
import { MysUserDB } from "../model/db/index.js";

// 扫码登录 API 端点（米哈游 App 通道）
const API_CREATE = "https://passport-api.mihoyo.com/account/ma-cn-passport/app/createQRLogin";
const API_QUERY = "https://passport-api.mihoyo.com/account/ma-cn-passport/app/queryQRLoginStatus";
// 用 stoken 换 cookie_token 的接口
const API_GET_COOKIE = "https://passport-api.mihoyo.com/account/auth/api/getCookieAccountInfoBySToken";

// HYPContainer 请求头（米哈游官方启动器通道）
function appRequest(url, { data, device_id }) {
  return fetch(url, {
    method: "post",
    body: data ? JSON.stringify(data) : "{}",
    headers: {
      "User-Agent": "HYPContainer/1.3.3.182",
      "x-rpc-app_id": "ddxf5dufpuyo",
      "x-rpc-client_type": "3",
      "x-rpc-device_id": device_id,
      "Content-Type": "application/json",
    },
  });
}

// 通用 passport 请求（Hyperion 头）
function passportRequest(url, { data, cookie } = {}) {
  const opts = {
    method: "post",
    headers: {
      "x-rpc-app_version": "2.104.0",
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-rpc-game_biz": "bbs_cn",
      "x-rpc-app_id": "bll8iq97cem8",
      "x-rpc-client_type": "2",
      "User-Agent": "Hyperion/550 CFNetwork/3860.500.112 Darwin/25.4.0",
    },
  };
  if (data) opts.body = JSON.stringify(data);
  if (cookie) opts.headers.Cookie = cookie;
  return fetch(url, opts);
}

function randomString(n) {
  return lodash
    .sampleSize(
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      n,
    )
    .join("");
}

// 进行中的扫码会话，按 user_id 索引
const Running = {};

export class miHoYoLogin extends plugin {
  constructor() {
    super({
      name: "米哈游扫码登录",
      dsc: "扫码登录米哈游账号，自动绑定ck和stoken",
      event: "message",
      priority: 300,
      rule: [
        {
          reg: "^#?扫码登录(终止)?$",
          fnc: "qrLogin",
        },
        {
          reg: "^#?扫码终止$",
          fnc: "qrTerminate",
        },
      ],
    });
  }

  /** 终止进行中的扫码登录 */
  qrTerminate() {
    if (Running[this.e.user_id]) {
      Running[this.e.user_id] = false;
      this.reply("已终止扫码登录", true);
    } else {
      this.reply("当前没有进行中的扫码登录", true);
    }
    return true;
  }

  /** 扫码登录主入口 */
  async qrLogin() {
    const terminate = this.e.msg.includes("终止");

    // 终止当前登录
    if (terminate && Running[this.e.user_id]) {
      Running[this.e.user_id] = false;
      return this.reply("已终止扫码登录", true);
    }

    // 已有进行中的登录
    if (Running[this.e.user_id]) {
      return this.reply(
        [
          "已有进行中的扫码登录",
          segment.button([{ text: "扫码终止", callback: "#扫码终止" }]),
        ],
        true,
      );
    }

    Running[this.e.user_id] = true;

    // 生成二维码
    const device_id = randomString(16);
    let res, ticket;
    try {
      res = await appRequest(API_CREATE, { device_id });
      res = await res.json();
      logger.mark(`[扫码登录] 创建二维码: ${JSON.stringify(res)}`);

      if (res.retcode !== 0) {
        Running[this.e.user_id] = false;
        return this.reply(`创建二维码失败: ${res.message || "unknown"}`, true);
      }

      const url = res.data.url;
      ticket = res.data.ticket;
      const img = segment.image(
        (await QR.toDataURL(url)).replace("data:image/png;base64,", "base64://"),
      );

      this.reply(
        [
          "请使用米游社 App 扫码登录",
          img,
          segment.button([{ text: "扫码终止", callback: "#扫码终止" }]),
        ],
        true,
        { recallMsg: 60 },
      );
    } catch (err) {
      logger.error("[扫码登录] 创建二维码异常:", err);
      Running[this.e.user_id] = false;
      return this.reply("创建二维码失败，请查看日志", true);
    }

    // 轮询扫码状态
    let scanned = false;
    let finalRes = null;
    for (let n = 1; n < 60; n++) {
      await lodash.sleep(5000);

      if (Running[this.e.user_id] === false) {
        return this.reply(
          [
            "扫码登录已终止",
            segment.button([{ text: "扫码登录", callback: "#扫码登录" }]),
          ],
          true,
        );
      }

      try {
        res = await appRequest(API_QUERY, {
          device_id,
          data: { ticket },
        });
        res = await res.json();

        if (res.retcode !== 0) {
          Running[this.e.user_id] = false;
          return this.reply(
            [
              "二维码已过期，请重新扫码登录",
              segment.button([{ text: "扫码登录", callback: "#扫码登录" }]),
            ],
            true,
          );
        }

        // 已扫描待确认
        if (res.data.status === "Scanned" && !scanned) {
          scanned = true;
          this.reply(
            [
              "二维码已扫描，请在米游社 App 中确认登录",
              segment.button([{ text: "扫码终止", callback: "#扫码终止" }]),
            ],
            true,
            { recallMsg: 60 },
          );
        }

        // 已确认，登录成功
        if (res.data.status === "Confirmed") {
          finalRes = res;
          logger.mark(`[扫码登录] 确认登录成功: ${JSON.stringify(res)}`);
          break;
        }
      } catch (err) {
        logger.error("[扫码登录] 轮询状态异常:", err);
      }
    }

    Running[this.e.user_id] = false;

    if (!finalRes) {
      return this.reply(
        [
          "扫码登录超时，请重新发起",
          segment.button([{ text: "扫码登录", callback: "#扫码登录" }]),
        ],
        true,
      );
    }

    // 解析扫码结果，提取 stoken / ltuid / mid
    const userInfo = finalRes.data.user_info;
    const tokens = finalRes.data.tokens;

    if (!userInfo || !tokens || !tokens.length) {
      return this.reply("扫码登录返回数据不完整，请重试", true);
    }

    const uid = userInfo.aid || userInfo.uid || userInfo.account_id;
    const mid = userInfo.mid;
    const stokenItem =
      tokens.find((i) => i.name === "stoken" || i.name === "stoken_v2") ||
      tokens[0];
    const stoken = stokenItem.token;

    if (!uid || !stoken || !mid) {
      return this.reply("扫码登录缺少必要字段(uid/stoken/mid)", true);
    }

    logger.mark(
      `[扫码登录] 提取完成 uid:${uid} mid:${mid} stoken:${stoken.slice(0, 8)}...`,
    );

    // 用 stoken 换 cookie_token
    const stokenCookie = `stoken=${stoken};stuid=${uid};mid=${mid}`;
    let cookieToken = "";
    try {
      let ckRes = await passportRequest(
        `${API_GET_COOKIE}?stoken=${stoken}&uid=${uid}&mid=${mid}`,
        { cookie: stokenCookie },
      );
      ckRes = await ckRes.json();
      logger.mark(`[扫码登录] 换 cookie_token: ${JSON.stringify(ckRes)}`);
      if (ckRes.retcode === 0 && ckRes.data?.cookie_token) {
        cookieToken = ckRes.data.cookie_token;
      }
    } catch (err) {
      logger.error("[扫码登录] 换 cookie_token 异常:", err);
    }

    // 拼接 MangoCat bing() 能识别的 ck 字符串
    // 格式: ltoken=xxx;ltuid=xxx;cookie_token=xxx;account_id=xxx;stoken=xxx;stuid=xxx;mid=xxx
    const ckStr = [
      `ltoken=${stoken}`, // 扫码通道没有独立 ltoken，用 stoken 代ltoken 位
      `ltuid=${uid}`,
      `cookie_token=${cookieToken}`,
      `account_id=${uid}`,
      `stoken=${stoken}`,
      `stuid=${uid}`,
      `mid=${mid}`,
    ].join(";");

    // 把 ck 挂到 e 上，调 User.bing() 走 MangoCat 原生绑定流程
    this.e.ck = ckStr;
    const user = new User(this.e);
    try {
      await user.bing();
    } catch (err) {
      logger.error("[扫码登录] 调用 User.bing() 异常:", err);
      return this.reply("绑定流程异常，请查看日志", true);
    }

    // stoken 单独写入 MysUserDB.stoken 字段
    try {
      const mysDb = await MysUserDB.find(Number(uid), true);
      if (mysDb) {
        mysDb.stoken = `stoken=${stoken};stuid=${uid};mid=${mid}`;
        await mysDb.save();
        logger.mark(`[扫码登录] stoken 已写入 MysUserDB ltuid:${uid}`);
      }
    } catch (err) {
      logger.error("[扫码登录] 写入 stoken 字段异常:", err);
    }

    // 同步更新 MysUser 实例的 stoken 字段（供 gachaLog 等运行时读取）
    try {
      const mys = await MysUser.create(uid);
      if (mys) {
        mys.stoken = `stoken=${stoken};stuid=${uid};mid=${mid}`;
        await mys.save();
        logger.mark(`[扫码登录] MysUser 实例 stoken 已更新 ltuid:${uid}`);
      }
    } catch (err) {
      logger.error("[扫码登录] 更新 MysUser 实例 stoken 异常:", err);
    }

    return true;
  }
}
