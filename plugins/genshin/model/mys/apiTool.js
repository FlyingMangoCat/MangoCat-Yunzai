import crypto from "crypto"
/**
 * 整合接口用于查询数据
 * 方便后续用于解耦
 * 临时处理，后续大概率重写 主要原因（懒）
 */
export default class apiTool {
  /**
   *
   * @param {用户uid} uid
   * @param {区服} server
   * @param {是否为星穹铁道或其他游戏? type(bool or string)} isSr
   */
  constructor(uid, server, isSr = false) {
    this.uid = uid;
    this.isSr = isSr;
    this.server = server;
    this.game = "genshin";
    if (isSr) this.game = "honkaisr";
    if (typeof isSr !== "boolean") {
      this.game = isSr;
    }
    this.uuid = crypto.randomUUID()
  }

  getUrlMap = (data = {}) => {
    let host, hostRecord, hostPublicData;
    if (
      ["cn_gf01", "cn_qd01", "prod_gf_cn", "prod_qd_cn", "nap_cn"].includes(this.server)
    ) {
      host = "https://api-takumi.mihoyo.com/";
      hostRecord = "https://api-takumi-record.mihoyo.com/";
      hostPublicData = "https://public-data-api.mihoyo.com/"
    } else if (
      ["os_usa", "os_euro", "os_asia", "os_cht", "nap_global"].includes(this.server)
    ) {
      host = "https://api-os-takumi.mihoyo.com/";
      hostRecord = "https://bbs-api-os.mihoyo.com/";
      hostPublicData = "https://sg-public-data-api.hoyoverse.com/"
    }
    let urlMap = {
      genshin: {
        /** 体力接口fp参数用于避开验证码 */
        ...(["cn_gf01", "cn_qd01"].includes(this.server)
          ? {
              getFp: {
                url: `${hostPublicData}device-fp/api/getFp`,
                body: {
                  seed_id: data.seed_id,
                  device_id: data.deviceId.toUpperCase(),
                  platform: "1",
                  seed_time: new Date().getTime() + "",
                  ext_fields: `{"proxyStatus":"0","accelerometer":"-0.159515x-0.830887x-0.682495","ramCapacity":"3746","IDFV":"${data.deviceId.toUpperCase()}","gyroscope":"-0.191951x-0.112927x0.632637","isJailBreak":"0","model":"iPhone12,5","ramRemain":"115","chargeStatus":"1","networkType":"WIFI","vendor":"--","osVersion":"17.0.2","batteryStatus":"50","screenSize":"414×896","cpuCores":"6","appMemory":"55","romCapacity":"488153","romRemain":"157348","cpuType":"CPU_TYPE_ARM64","magnetometer":"-84.426331x-89.708435x-37.117889"}`,
                  app_name: "bbs_cn",
                  device_fp: "38d7ee834d1e9",
                },
              },
            }
          : {
              getFp: {
                url: `${hostPublicData}device-fp/api/getFp`,
                body: {
                  seed_id: `${this.uuid}`,
                  device_id: "35315696b7071100",
                  hoyolab_device_id: `${this.uuid}`,
                  platform: "2",
                  seed_time: new Date().getTime() + "",
                  ext_fields: `{"proxyStatus":1,"isRoot":1,"romCapacity":"512","deviceName":"Xperia 1","productName":"J9110","romRemain":"483","hostname":"BuildHost","screenSize":"1096x2434","isTablet":0,"model":"J9110","brand":"Sony","hardware":"qcom","deviceType":"J9110","devId":"REL","serialNumber":"unknown","sdCapacity":107433,"buildTime":"1633631032000","buildUser":"BuildUser","simState":1,"ramRemain":"98076","appUpdateTimeDiff":1716545162858,"deviceInfo":"Sony\/J9110\/J9110:11\/55.2.A.4.332\/055002A004033203408384484:user\/release-keys","buildType":"user","sdkVersion":"30","ui_mode":"UI_MODE_TYPE_NORMAL","isMockLocation":0,"cpuType":"arm64-v8a","isAirMode":0,"ringMode":2,"app_set_id":"${this.uuid}","chargeStatus":1,"manufacturer":"Sony","emulatorStatus":0,"appMemory":"512","adid":"${this.uuid}","osVersion":"11","vendor":"unknown","accelerometer":"-0.9233304x7.574181x6.472585","sdRemain":97931,"buildTags":"release-keys","packageName":"com.mihoyo.hoyolab","networkType":"WiFi","debugStatus":1,"ramCapacity":"107433","magnetometer":"-9.075001x-27.300001x-3.3000002","display":"55.2.A.4.332","appInstallTimeDiff":1716489549794,"packageVersion":"","gyroscope":"0.027029991x-0.04459185x0.032222193","batteryStatus":45,"hasKeyboard":0,"board":"msmnile"}`,
                  app_name: "bbs_oversea",
                  device_fp: "38d7f2352506c",
                },
              },
            }),
        /** 首页宝箱 */
        index: {
          url: `${hostRecord}game_record/app/genshin/api/index`,
          query: `role_id=${this.uid}&server=${this.server}`,
        },
        /** 深渊 */
        spiralAbyss: {
          url: `${hostRecord}game_record/app/genshin/api/spiralAbyss`,
          query: `role_id=${this.uid}&schedule_type=${data.schedule_type || 1}&server=${this.server}`,
        },
        /** 角色详情 */
        character: {
          url: `${hostRecord}game_record/app/genshin/api/character/list`,
          body: { role_id: this.uid, server: this.server },
        },
        /** 角色面板 */
        characterDetail: {
          url: `${hostRecord}game_record/app/genshin/api/character/detail`,
          body: { role_id: this.uid, server: this.server, character_ids: data.character_ids },
        },
        /** 树脂 */
        dailyNote: {
          url: `${hostRecord}game_record/app/genshin/api/dailyNote`,
          query: `role_id=${this.uid}&server=${this.server}`,
        },
        /** 签到信息 */
        bbs_sign_info: {
          url: `${host}event/bbs_sign_reward/info`,
          query: `act_id=e202009291139501&region=${this.server}&uid=${this.uid}`,
          sign: true,
        },
        /** 签到奖励 */
        bbs_sign_home: {
          url: `${host}event/bbs_sign_reward/home`,
          query: `act_id=e202009291139501&region=${this.server}&uid=${this.uid}`,
          sign: true,
        },
        /** 签到 */
        bbs_sign: {
          url: `${host}event/bbs_sign_reward/sign`,
          body: {
            act_id: "e202009291139501",
            region: this.server,
            uid: this.uid,
          },
          sign: true,
        },
        /** 详情 */
        detail: {
          url: `${host}event/e20200928calculate/v1/sync/avatar/detail`,
          query: `uid=${this.uid}&region=${this.server}&avatar_id=${data.avatar_id}`,
        },
        /** 札记 */
        ys_ledger: {
          url: "https://hk4e-api.mihoyo.com/event/ys_ledger/monthInfo",
          query: `month=${data.month}&bind_uid=${this.uid}&bind_region=${this.server}`,
        },
        /** 养成计算器 */
        compute: {
          url: `${host}event/e20200928calculate/v2/compute`,
          body: data,
        },
        blueprintCompute: {
          url: `${host}event/e20200928calculate/v1/furniture/compute`,
          body: data,
        },
        /** 养成计算器 */
        blueprint: {
          url: `${host}event/e20200928calculate/v1/furniture/blueprint`,
          query: `share_code=${data.share_code}&region=${this.server}`,
        },
        /** 角色技能 */
        avatarSkill: {
          url: `${host}event/e20200928calculate/v1/avatarSkill/list`,
          query: `avatar_id=${data.avatar_id}`,
        },
        /** 七圣召唤数据 */
        basicInfo: {
          url: `${hostRecord}game_record/app/genshin/api/gcg/basicInfo`,
          query: `role_id=${this.uid}&server=${this.server}`,
        },
        /** 获取抽卡authkey */
        genAuthKey: {
          url: `${host}binding/api/genAuthKey`,
          body: {
            auth_appid: "webview_gacha",
            game_biz: "hk4e_cn",
            game_uid: Number(data.game_uid),
            region: data.region,
          },
          sign: true,
        },
        /**使用兑换码 目前仅限国际服,来自于国服的uid请求已在myinfo.js的init方法提前拦截 */
        useCdk: {
          url: "PLACE_HOLDER",
          query: null,
        },
      },
      honkaisr: {
        /** 体力接口fp参数用于避开验证码 */
        ...(["prod_gf_cn", "prod_qd_cn"].includes(this.server)
          ? {
              getFp: {
                url: `${hostPublicData}device-fp/api/getFp`,
                body: {
                  seed_id: data.seed_id,
                  device_id: data.deviceId.toUpperCase(),
                  platform: "1",
                  seed_time: new Date().getTime() + "",
                  ext_fields: `{"proxyStatus":"0","accelerometer":"-0.159515x-0.830887x-0.682495","ramCapacity":"3746","IDFV":"${data.deviceId.toUpperCase()}","gyroscope":"-0.191951x-0.112927x0.632637","isJailBreak":"0","model":"iPhone12,5","ramRemain":"115","chargeStatus":"1","networkType":"WIFI","vendor":"--","osVersion":"17.0.2","batteryStatus":"50","screenSize":"414×896","cpuCores":"6","appMemory":"55","romCapacity":"488153","romRemain":"157348","cpuType":"CPU_TYPE_ARM64","magnetometer":"-84.426331x-89.708435x-37.117889"}`,
                  app_name: "bbs_cn",
                  device_fp: "38d7ee834d1e9",
                },
              },
            }
          : {
              getFp: {
                url: `${hostPublicData}device-fp/api/getFp`,
                body: {
                  seed_id: `${this.uuid}`,
                  device_id: "35315696b7071100",
                  hoyolab_device_id: `${this.uuid}`,
                  platform: "2",
                  seed_time: new Date().getTime() + "",
                  ext_fields: `{"proxyStatus":1,"isRoot":1,"romCapacity":"512","deviceName":"Xperia 1","productName":"J9110","romRemain":"483","hostname":"BuildHost","screenSize":"1096x2434","isTablet":0,"model":"J9110","brand":"Sony","hardware":"qcom","deviceType":"J9110","devId":"REL","serialNumber":"unknown","sdCapacity":107433,"buildTime":"1633631032000","buildUser":"BuildUser","simState":1,"ramRemain":"98076","appUpdateTimeDiff":1716545162858,"deviceInfo":"Sony\/J9110\/J9110:11\/55.2.A.4.332\/055002A004033203408384484:user\/release-keys","buildType":"user","sdkVersion":"30","ui_mode":"UI_MODE_TYPE_NORMAL","isMockLocation":0,"cpuType":"arm64-v8a","isAirMode":0,"ringMode":2,"app_set_id":"${this.uuid}","chargeStatus":1,"manufacturer":"Sony","emulatorStatus":0,"appMemory":"512","adid":"${this.uuid}","osVersion":"11","vendor":"unknown","accelerometer":"-0.9233304x7.574181x6.472585","sdRemain":97931,"buildTags":"release-keys","packageName":"com.mihoyo.hoyolab","networkType":"WiFi","debugStatus":1,"ramCapacity":"107433","magnetometer":"-9.075001x-27.300001x-3.3000002","display":"55.2.A.4.332","appInstallTimeDiff":1716489549794,"packageVersion":"","gyroscope":"0.027029991x-0.04459185x0.032222193","batteryStatus":45,"hasKeyboard":0,"board":"msmnile"}`,
                  app_name: "bbs_oversea",
                  device_fp: "38d7f2352506c",
                },
              },
            }),
        /** 首页宝箱 */
        index: {
          url: `${hostRecord}game_record/app/hkrpg/api/index`,
          query: `role_id=${this.uid}&server=${this.server}`,
        },
        UserGame: {
          url: `${host}common/badge/v1/login/account`,
          body: {
            uid: this.uid,
            region: this.server,
            lang: "zh-cn",
            game_biz: "hkrpg_cn",
          },
        },
        /**
         * 开拓阅历接口
         */
        ys_ledger: {
          url: `${host}/event/srledger/month_info`,
          query: `lang=zh-cn&region=${this.server}&uid=${this.uid}&month=${data.month}`,
        },
        /** 角色面板 */
        avatarInfo: {
          url: `${hostRecord}game_record/app/hkrpg/api/avatar/info`,
          query: `need_wiki=true&role_id=${this.uid}&server=${this.server}`,
        },
        /** 角色详情 */
        character: {
          url: `${hostRecord}game_record/app/hkrpg/api/avatar/basic`,
          query: `role_id=${this.uid}&server=${this.server}`,
        },
        /** 树脂 */
        dailyNote: {
          url: `${hostRecord}game_record/app/hkrpg/api/note`,
          query: `role_id=${this.uid}&server=${this.server}`,
        },
        /** 签到信息 */
        bbs_sign_info: {
          url: `${host}event/luna/info`,
          query: `act_id=e202304121516551&region=${this.server}&uid=${this.uid}`,
          sign: true,
        },
        /** 签到奖励 */
        bbs_sign_home: {
          url: `${host}event/luna/home`,
          query: `act_id=e202304121516551&region=${this.server}&uid=${this.uid}`,
          sign: true,
        },
        /** 签到 */
        bbs_sign: {
          url: `${host}event/luna/sign`,
          body: {
            act_id: "e202304121516551",
            region: this.server,
            uid: this.uid,
          },
          sign: true,
        },
        /** 获取抽卡authkey */
        genAuthKey: {
          url: `${host}binding/api/genAuthKey`,
          body: {
            auth_appid: "webview_gacha",
            game_biz: "hkrpg_cn",
            game_uid: Number(data.game_uid),
            region: data.region,
          },
          dsSalt: "web",
        },
      },
      zzz: {
        /** 体力接口fp参数用于避开验证码 */
        ...(["nap_cn"].includes(this.server)
          ? {
              getFp: {
                url: `${hostPublicData}device-fp/api/getFp`,
                body: {
                  seed_id: data.seed_id,
                  device_id: data.deviceId.toUpperCase(),
                  platform: "1",
                  seed_time: new Date().getTime() + "",
                  ext_fields: `{"proxyStatus":"0","accelerometer":"-0.159515x-0.830887x-0.682495","ramCapacity":"3746","IDFV":"${data.deviceId.toUpperCase()}","gyroscope":"-0.191951x-0.112927x0.632637","isJailBreak":"0","model":"iPhone12,5","ramRemain":"115","chargeStatus":"1","networkType":"WIFI","vendor":"--","osVersion":"17.0.2","batteryStatus":"50","screenSize":"414×896","cpuCores":"6","appMemory":"55","romCapacity":"488153","romRemain":"157348","cpuType":"CPU_TYPE_ARM64","magnetometer":"-84.426331x-89.708435x-37.117889"}`,
                  app_name: "bbs_cn",
                  device_fp: "38d7ee834d1e9",
                },
              },
            }
          : {
              getFp: {
                url: `${hostPublicData}device-fp/api/getFp`,
                body: {
                  seed_id: `${this.uuid}`,
                  device_id: "35315696b7071100",
                  hoyolab_device_id: `${this.uuid}`,
                  platform: "2",
                  seed_time: new Date().getTime() + "",
                  ext_fields: `{"proxyStatus":1,"isRoot":1,"romCapacity":"512","deviceName":"Xperia 1","productName":"J9110","romRemain":"483","hostname":"BuildHost","screenSize":"1096x2434","isTablet":0,"model":"J9110","brand":"Sony","hardware":"qcom","deviceType":"J9110","devId":"REL","serialNumber":"unknown","sdCapacity":107433,"buildTime":"1633631032000","buildUser":"BuildUser","simState":1,"ramRemain":"98076","appUpdateTimeDiff":1716545162858,"deviceInfo":"Sony\/J9110\/J9110:11\/55.2.A.4.332\/055002A004033203408384484:user\/release-keys","buildType":"user","sdkVersion":"30","ui_mode":"UI_MODE_TYPE_NORMAL","isMockLocation":0,"cpuType":"arm64-v8a","isAirMode":0,"ringMode":2,"app_set_id":"${this.uuid}","chargeStatus":1,"manufacturer":"Sony","emulatorStatus":0,"appMemory":"512","adid":"${this.uuid}","osVersion":"11","vendor":"unknown","accelerometer":"-0.9233304x7.574181x6.472585","sdRemain":97931,"buildTags":"release-keys","packageName":"com.mihoyo.hoyolab","networkType":"WiFi","debugStatus":1,"ramCapacity":"107433","magnetometer":"-9.075001x-27.300001x-3.3000002","display":"55.2.A.4.332","appInstallTimeDiff":1716489549794,"packageVersion":"","gyroscope":"0.027029991x-0.04459185x0.032222193","batteryStatus":45,"hasKeyboard":0,"board":"msmnile"}`,
                  app_name: "bbs_oversea",
                  device_fp: "38d7f2352506c",
                },
              },
            }),
        /** 首页信息 */
        index: {
          url: `${hostRecord}event/game_record_zzz/api/zzz/index`,
          query: `role_id=${this.uid}&server=${this.server}`,
        },
        /** 角色详情 */
        character: {
          url: `${hostRecord}event/game_record_zzz/api/zzz/avatar/basic`,
          query: `role_id=${this.uid}&server=${this.server}`,
        },
        /** 电量 */
        dailyNote: {
          url: `${hostRecord}event/game_record_zzz/api/zzz/note`,
          query: `role_id=${this.uid}&server=${this.server}`,
        },
        /** 邦布 */
        buddy: {
          url: `${hostRecord}event/game_record_zzz/api/zzz/buddy/info`,
          query: `role_id=${this.uid}&server=${this.server}`,
        },
      },
    };

    if (this.server.startsWith("os")) {
      urlMap.genshin.bbs_sign_info.url =
        "https://hk4e-api-os.hoyoverse.com/event/sol/info";
      urlMap.genshin.bbs_sign_info.query = `act_id=e202102251931481&region=${this.server}&uid=${this.uid}`;
      urlMap.genshin.bbs_sign_home.url =
        "https://hk4e-api-os.hoyoverse.com/event/sol/home";
      urlMap.genshin.bbs_sign_home.query = `act_id=e202102251931481&region=${this.server}&uid=${this.uid}`;
      urlMap.genshin.bbs_sign.url =
        "https://hk4e-api-os.hoyoverse.com/event/sol/sign";
      urlMap.genshin.bbs_sign.body = {
        act_id: "e202102251931481",
        region: this.server,
        uid: this.uid,
      };
      urlMap.genshin.detail.url =
        "https://sg-public-api.hoyolab.com/event/calculateos/sync/avatar/detail"; // 角色天赋详情
      urlMap.genshin.detail.query = `lang=zh-cn&uid=${this.uid}&region=${this.server}&avatar_id=${data.avatar_id}`;
      urlMap.genshin.avatarSkill.url =
        "https://sg-public-api.hoyolab.com/event/calculateos/avatar/skill_list"; // 查询未持有的角色天赋
      urlMap.genshin.avatarSkill.query = `lang=zh-cn&avatar_id=${data.avatar_id}`;
      urlMap.genshin.compute.url =
        "https://sg-public-api.hoyolab.com/event/calculateos/compute"; // 已支持养成计算
      urlMap.genshin.blueprint.url =
        "https://sg-public-api.hoyolab.com/event/calculateos/furniture/blueprint";
      urlMap.genshin.blueprint.query = `share_code=${data.share_code}&region=${this.server}&lang=zh-cn`;
      urlMap.genshin.blueprintCompute.url =
        "https://sg-public-api.hoyolab.com/event/calculateos/furniture/compute";
      urlMap.genshin.blueprintCompute.body = { lang: "zh-cn", ...data };
      urlMap.genshin.ys_ledger.url =
        "https://hk4e-api-os.mihoyo.com/event/ysledgeros/month_info"; // 支持了国际服札记
      urlMap.genshin.ys_ledger.query = `lang=zh-cn&month=${data.month}&uid=${this.uid}&region=${this.server}`;
      urlMap.genshin.useCdk.url =
        "https://sg-hk4e-api.hoyoverse.com/common/apicdkey/api/webExchangeCdkey";
      urlMap.genshin.useCdk.query = `uid=${this.uid}&region=${this.server}&lang=zh-cn&cdkey=${data.cdk}&game_biz=hk4e_global`;
    }
    if (this.isSr && this.server.includes("official")) {
      urlMap.honkaisr.bbs_sign.url = `https://sg-public-api.hoyolab.com/event/luna/os/sign`;
      urlMap.honkaisr.bbs_sign.body = {
        act_id: "e202303301540311",
        lang: "zh-cn",
      };
      urlMap.honkaisr.bbs_sign_home.url = `https://sg-public-api.hoyolab.com/event/luna/os/home`;
      urlMap.honkaisr.bbs_sign_home.query = `act_id=e202303301540311&region=${this.server}&uid=${this.uid}&lang=zh-cn`;

      urlMap.honkaisr.bbs_sign_info.url = `https://sg-public-api.hoyolab.com/event/luna/os/info`;
      urlMap.honkaisr.bbs_sign_info.query = `act_id=e202303301540311&region=${this.server}&uid=${this.uid}&lang=zh-cn`;
    }
    return urlMap[this.game];
  };
}