import plugin from "../../../lib/plugins/plugin.js";
import fs from "node:fs";
import common from "../../../lib/common/common.js";
import GachaLog from "../model/gachaLog.js";
import ExportLog from "../model/exportLog.js";
import LogCount from "../model/logCount.js";
import fetch from "node-fetch";
import moment from "moment";

const _path = process.cwd() + "/plugins/genshin";

export class gcLog extends plugin {
  constructor() {
    super({
      name: "抽卡记录",
      dsc: "抽卡记录数据统计",
      event: "message",
      priority: 300,
      rule: [
        {
          reg: "(.*)authkey=(.*)",
          fnc: "logUrl",
        },
        {
          reg: "#txt日志文件导入记录",
          fnc: "logFile",
        },
        {
          reg: "#xlsx文件导入记录",
          fnc: "logXlsx",
        },
        {
          reg: "#json文件导入记录",
          fnc: "logJson",
        },
        {
          reg: "^#*(原神|星铁|崩坏星穹铁道|铁道)?(全部)?(抽卡|抽奖|角色|角色联动|武器|武器联动|集录|常驻|up|新手|光锥|光锥联动|全部)池*(记录|祈愿|分析)$",
          fnc: "getLog",
        },
        {
          reg: "^#*导出记录(excel|xlsx|json)*$",
          fnc: "exportLog",
        },
        {
          reg: "^#*(记录帮助|抽卡帮助)$",
          fnc: "help",
        },
        {
          reg: "^#*(安卓|苹果|电脑|pc|ios)帮助$",
          fnc: "helpPort",
        },
        {
          reg: "^#*(原神|星铁|崩坏星穹铁道|铁道)?(抽卡|抽奖|角色|武器|常驻|up|新手|光锥)池*统计$",
          fnc: "logCount",
        },
        {
          reg: "#*(星铁|崩坏星穹铁道|铁道)更新抽卡记录",
          fnc: "updateGachaLog",
        },
        {
          reg: "^#?(获取|更新)(提瓦特)?小助手(抽卡|祈愿)?(记录|历史)( *|(\r|\n)*)(https.*)?",
          fnc: "updateAssistGachaLog",
        },
      ],
    });

    this.androidUrl = "docs.qq.com/doc/DUWpYaXlvSklmVXlX";
    this.assistTypeName = {
      301: "角色",
      302: "武器",
      500: "集录",
      200: "常驻",
    };
    this._path = process.cwd().replace(/\\/g, "/");
    Object.defineProperty(this, "button", {
      get() {
        this.prefix = this.e?.isSr ? "*" : "#";
        return segment.button(
          [
            { text: "角色记录", callback: `${this.prefix}角色记录` },
            { text: "角色统计", callback: `${this.prefix}角色统计` },
          ],
          [
            { text: "武器记录", callback: `${this.prefix}武器记录` },
            { text: "武器统计", callback: `${this.prefix}武器统计` },
          ],
          [
            { text: "角色联动记录", callback: `${this.prefix}角色联动记录` },
            { text: "角色联动统计", callback: `${this.prefix}角色联动统计` },
          ],
          [
            { text: "武器联动记录", callback: `${this.prefix}武器联动记录` },
            { text: "武器联动统计", callback: `${this.prefix}武器联动统计` },
          ],
          [
            { text: "集录记录", callback: `${this.prefix}集录记录` },
            { text: "集录统计", callback: `${this.prefix}集录统计` },
          ],
          [
            { text: "常驻记录", callback: `${this.prefix}常驻记录` },
            { text: "常驻统计", callback: `${this.prefix}常驻统计` },
          ],
        );
      },
    });
  }

  async init() {
    let file = ["./data/gachaJson", "./data/srJson", "./data/html/StarRail"];
    for (let i of file) {
      if (!fs.existsSync(i)) {
        fs.mkdirSync(i);
      }
    }
  }

  accept() {
    if (this.e.file && this.e.isPrivate) {
      let name = this.e.file?.name || "";
      if (name.includes("txt")) {
        this.e.msg = "#txt日志文件导入记录";
        if (name.includes("output")) return true;
      }
      if (/(.*)[1-9][0-9]{8}(.*).xlsx$/gi.test(name)) {
        this.e.msg = "#xlsx文件导入记录";
        return true;
      }
      if (/(.*)[1-9][0-9]{8}(.*).json/gi.test(name)) {
        this.e.msg = "#json文件导入记录";
        return true;
      }
    }
    if (this.e.msg && /^#*(角色|武器)统计$/g.test(this.e.msg)) {
      this.e.msg = this.e.msg.replace("统计", "池统计");
      return true;
    }
  }

  /** 抽卡记录链接 */
  async logUrl() {
    if (!this.e.isPrivate) {
      this.e.reply("请私聊发送链接", false, { at: true });
      return true;
    }

    let data = await new GachaLog(this.e).logUrl();
    if (!data) return;

    await this.renderImg("genshin", `html/gacha/gacha-log`, data);

    if (this.e.isGroup) this.e.reply("已收到链接，请撤回", false, { at: true });
  }

  /** 发送output_log.txt日志文件 */
  async logFile() {
    if (!this.e.isPrivate) {
      await this.e.reply("请私聊发送日志文件", false, { at: true });
      return true;
    }

    if (!this.e.file || !(this.e.file.name || "").includes("txt")) {
      await this.e.reply("请发送日志文件");
    } else {
      await this.e.reply(
        "3.0版本后，日志文件已不能获取抽取记录链接\n请用安卓方式获取",
      );
      return true;
    }

    let data = await new GachaLog(this.e).logFile();
    if (!data) return false;

    if (typeof data != "object") return;
    await this.renderImg("genshin", `html/gacha/gacha-log`, data);
  }

  /** #抽卡记录 */
  async getLog() {
    this.e.isAll = !!this.e.msg.includes("全部");
    let data = await new GachaLog(this.e).getLogData();
    if (!data) return;
    let name = `html/gacha/gacha-log`;
    if (this.e.isAll) {
      name = `html/gacha/gacha-all-log`;
    }
    this.reply([await this.renderImg("genshin", name, data, { retType: "base64" }), this.button]);
  }

  /** 导出记录 */
  async exportLog() {
    if (this.e.isGroup) {
      await this.reply("请私聊导出", false, { at: true });
      return;
    }

    let friend = Bot.fl.get(Number(this.e.user_id));
    if (!friend) {
      await this.reply("无法发送文件，请先添加好友");
      return;
    }

    let exportLog = new ExportLog(this.e);

    if (this.e.msg.includes("json")) {
      return await exportLog.exportJson();
    } else {
      return await exportLog.exportXlsx();
    }
  }

  async logXlsx() {
    if (!this.e.isPrivate) {
      await this.e.reply("请私聊发送日志文件", false, { at: true });
      return true;
    }

    if (!this.e.file) {
      await this.e.reply("请发送xlsx文件");
      return true;
    }

    await new ExportLog(this.e).logXlsx();
  }

  async logJson() {
    if (!this.e.isPrivate) {
      await this.e.reply("请私聊发送Json文件", false, { at: true });
      return true;
    }

    if (!this.e.file) {
      await this.e.reply("请发送Json文件");
      return true;
    }

    await new ExportLog(this.e).logJson();
  }

  async help() {
    await this.e.reply(
      segment.image(`file:///${_path}/resources/logHelp/记录帮助.png`),
    );
  }

  async helpPort() {
    let msg = this.e.msg.replace(/#|帮助/g, "");

    if (["电脑", "pc"].includes(msg)) {
      await this.e.reply(
        segment.image(`file:///${_path}/resources/logHelp/记录帮助-电脑.png`),
      );
    } else if (["安卓"].includes(msg)) {
      await this.e.reply(`安卓抽卡记录获取教程：${this.androidUrl}`);
    } else if (["苹果", "ios"].includes(msg)) {
      await this.e.reply(
        segment.image(`file:///${_path}/resources/logHelp/记录帮助-苹果.png`),
      );
    }
  }
  srHead = (url, data) => {
    let name = url;
    if (this.e.isSr) {
      name = `StarRail/${url}`;
    }
    return name;
  };
  async logCount() {
    let data = await new LogCount(this.e).count();
    if (!data) return;
    this.reply([
      await this.renderImg("genshin", `html/gacha/log-count`, data, { retType: "base64" }),
      this.button,
    ]);
  }

  /** #星铁更新抽卡记录 — 优先使用用户发送的抽卡链接,无则自动获取 */
  async updateGachaLog() {
    let gachaLog = new GachaLog(this.e);

    /** 解析 uid,判断是否已有用户发送的链接 */
    await gachaLog.resolveUid()
    let useUserLink = await gachaLog.hasUserLink()

    /** 无用户链接时才自动获取,避免覆盖用户发送的链接 */
    if (!useUserLink) {
      let ok = await gachaLog.getAuthKeyFromCookie();
      if (!ok) return;
      this.e.reply("链接获取成功，数据获取中……");
    } else {
      this.e.reply("检测到您发送的抽卡链接，使用该链接更新记录...");
    }

    gachaLog.fetchFullLog = await gachaLog.isFetchFullLog();

    let MakeMsg = [];
    let tmpMsg = "";
    for (let i in gachaLog.pool) {
      gachaLog.type = gachaLog.pool[i].type;
      gachaLog.typeName = gachaLog.pool[i].typeName;
      let res = await gachaLog.updateLog();
      if (res) {
        tmpMsg += `[${gachaLog.typeName}]记录获取成功，更新${res.num}条\n`;
      }
      if (i <= 1) await common.sleep(500);
    }

    /** 用户链接更新失败:再尝试自动获取兜底 */
    if (!tmpMsg && useUserLink) {
      this.e.reply("您发送的抽卡链接已失效或过期，尝试自动获取authkey...");
      let ok = await gachaLog.getAuthKeyFromCookie();
      if (ok) {
        tmpMsg = "";
        for (let i in gachaLog.pool) {
          gachaLog.type = gachaLog.pool[i].type;
          gachaLog.typeName = gachaLog.pool[i].typeName;
          let res = await gachaLog.updateLog();
          if (res) {
            tmpMsg += `[${gachaLog.typeName}]记录获取成功，更新${res.num}条\n`;
          }
          if (i <= 1) await common.sleep(500);
        }
      }
    }

    /** 所有卡池都更新失败：明确提示，不再假成功 */
    if (!tmpMsg) {
      this.e.reply(
        this.e.isSr
          ? "抽卡记录更新失败：星铁无法通过cookie自动获取authkey（官方接口限制），请打开游戏→跃迁记录页面→复制链接，私聊发送给我"
          : "抽卡记录更新失败：authkey无效或已过期，请重新绑定cookie后重试",
        false,
        { at: true },
      );
      return;
    }
    MakeMsg.push(tmpMsg);
    MakeMsg.push(
      `\n抽卡记录更新完成，您还可回复\n【${this.e.isSr ? "*" : "#"}全部记录】统计全部抽卡数据\n【${this.e.isSr ? "*光锥" : "#武器"}记录】统计${this.e.isSr ? "星铁光锥" : "武器"}池数据\n【${this.e.isSr ? "*" : "#"}角色统计】按卡池统计数据\n【${this.e.isSr ? "*" : "#"}导出记录】导出记录数据`,
    );
    await this.e.reply(MakeMsg);

    if (gachaLog.fetchFullLog) {
      await gachaLog.setFetchFullLog(false);
    }
  }

  /** #更新小助手抽卡记录 — 通过提瓦特小助手(lelaer)获取并合并到本地 */
  async updateAssistGachaLog() {
    let gachaLog = new GachaLog(this.e)
    /** 解析uid */
    await gachaLog.resolveUid()
    if (!gachaLog.uid) {
      await this.e.reply("请先绑定UID")
      return true
    }

    let authkey = ""
    /** 带链接:解析并验证 */
    let ret = /https.*/.exec(this.e.msg)
    if (ret) {
      this.e.msg = ret[0]
      let param = gachaLog.dealUrl(this.e.msg)
      if (!param) return true
      if (!(await gachaLog.checkUrl(param))) return true
      authkey = param.authkey
      this.e.region = param.region
    } else {
      /** 无链接:redis 取 authkey */
      authkey = await redis.get(`${gachaLog.urlKey}${gachaLog.uid}`)
      if (!authkey) {
        /** 尝试自动获取 */
        let ok = await gachaLog.getAuthKeyFromCookie()
        if (!ok) {
          await this.e.reply("请私聊发送抽卡记录链接", false, { at: true })
          this.setContext("updateAssistGachaLog")
          return true
        }
        authkey = await redis.get(`${gachaLog.urlKey}${gachaLog.uid}`)
      }
      if (!authkey) {
        await this.e.reply("请私聊发送抽卡记录链接", false, { at: true })
        this.setContext("updateAssistGachaLog")
        return true
      }
      this.e.region = gachaLog.getServer()
    }

    /** 验证 authkey 有效 */
    let res = await gachaLog.logApi({ gacha_type: 301, authkey, region: this.e.region })
    if (res.retcode !== 0 || !res?.data?.list || res.data.list.length <= 0) {
      await this.e.reply("请私聊发送抽卡记录链接", false, { at: true })
      this.setContext("updateAssistGachaLog")
      return true
    }

    /** 构造 gachaURL 并请求 lelaer */
    let gachaURL = encodeURIComponent(`https://hk4e-api.mihoyo.com/event/gacha_info/api/getGachaLog?authkey_ver=1&sign_type=2&auth_appid=webview_gacha&init_type=301&gacha_id=fecafa7b6560db5f3182222395d88aaa6aaac1bc&timestamp=${Math.floor(Date.now() / 1000)}&lang=zh-cn&device_type=mobile&plat_type=ios&region=${this.e.region}&authkey=${encodeURIComponent(authkey)}&game_biz=hk4e_cn&gacha_type=301&page=1&size=5&end_id=0`)
    let url = "https://www.lelaer.com/outputGacha.php"
    let body = `uid=${gachaLog.uid}&gachaurl=${gachaURL}&lang=zh-Hans`
    let param = {
      headers: {
        "Host": "www.lelaer.com",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      timeout: 10000,
      method: "post",
      body: body
    }
    let response = await fetch(url, param)
    let json = await response.json()
    let list = json?.list
    if (!json || !list) {
      await this.e.reply(`更新失败 ${json?.result}`)
      return true
    }
    if (!list?.length || list?.length <= 0) {
      await this.e.reply("「提瓦特小助手」抽卡记录为空")
      return true
    }
    let data = dealJson(list, this.e)
    if (!data) return true

    /** 合并写回(读本地 → 内存合并 → 写回,不破坏本地) */
    let msg = []
    for (let type in data) {
      if (!this.assistTypeName[type]) continue
      gachaLog.type = type
      gachaLog.typeName = this.assistTypeName[type]
      let log = gachaLog.readJson()
      let finalJson = mergeJson(log.list, data[type])
      gachaLog.writeJson(finalJson)
      msg.push(`[${this.assistTypeName[type]}]记录：${data[type].length}条，现共${finalJson.length}条`)
    }
    msg.push("导入成功")
    await this.e.reply(msg.join("\n"))
    return true
  }
}

/** 小助手记录按卡池分组 */
function dealJson(list, e) {
  let data = {}

  /** 必要字段 */
  let reqField = ["gacha_type", "item_type", "name", "time"]

  for (let v of reqField) {
    if (!list[0][v]) {
      e.reply(`json文件内容错误：缺少必要字段${v}`)
      return false
    }
  }

  /** 倒序 */
  if (moment(list[0].time).format("x") < moment(list[list.length - 1].time).format("x")) {
    list = list.reverse()
  }

  for (let v of list) {
    if (!data[v.uigf_gacha_type]) data[v.uigf_gacha_type] = []
    data[v.uigf_gacha_type].push(v)
  }

  return data
}

/** 合并去重(纯内存,不直接修改本地) */
function mergeJson(json, jsonNew) {
  function unique(arr) {
    const res = new Map()
    return arr.filter((a) => !res.has(a.id) && res.set(a.id, 1))
  }
  return unique(json.concat(jsonNew)).sort((a, b) => {
    return Number(b.id) - Number(a.id)
  })
}
