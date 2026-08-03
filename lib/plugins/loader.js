import util from "node:util";
import fs from "node:fs";
import lodash from "lodash";
import cfg from "../config/config.js";
import plugin from "./plugin.js";
import schedule from "node-schedule";
import { segment } from "icqq";
import chokidar from "chokidar";
import moment from "moment";
import path from "node:path";
import common from "../common/common.js";
import Runtime from "./runtime.js";

/**
 * 设置全局变量 plugin 和 segment，供其他模块使用
 * plugin - 插件基类
 * segment - 消息段处理工具
 */
global.plugin = plugin;
global.segment = segment;

/**
 * 插件加载器类
 * 负责加载、管理所有插件，包括插件的生命周期、事件处理、权限控制等
 */
class PluginsLoader {
  /**
   * 构造函数 - 初始化插件加载器
   * 设置插件管理所需的数据结构和配置
   */
  constructor() {
    /**
     * 插件优先级列表 - 存储所有已加载插件的信息，按优先级排序
     * @type {Array<{class: Object, key: string, name: string, priority: number}>}
     */
    this.priority = [];
    
    /**
     * 定时任务列表 - 存储所有插件定义的定时任务
     * @type {Array<Object>}
     */
    this.task = [];
    
    /**
     * 插件目录路径 - 扫描插件的根目录
     * @type {string}
     */
    this.dir = "./plugins";

    /**
     * 群聊命令冷却 - 防止机器人在群聊中发送消息过于频繁
     * @type {Object<string, boolean>}
     */
    this.groupCD = {};
    
    /**
     * 单聊命令冷却 - 防止机器人在与单个用户交互中发送消息过于频繁
     * @type {Object<string, boolean>}
     */
    this.singleCD = {};

    /**
     * 消息去重 - 防止同一消息被重复处理
     * 在200ms内丢弃相同用户发送的相同消息
     * @type {Object<string, boolean>}
     */
    this.msgThrottle = {};

    /**
     * 事件类型映射表 - 用于 filtEvent 方法匹配事件类型
     * @type {Object<string, string[]>}
     */
    this.eventMap = {
      message: ["post_type", "message_type", "sub_type"],
      notice: ["post_type", "notice_type", "sub_type"],
      request: ["post_type", "request_type", "sub_type"],
    };

    /**
     * 星铁/绝区零命令前缀检测正则
     */
    this.srReg = /^#?(\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/;

    /**
     * 绝区零命令前缀检测正则
     */
    this.zzzReg = /^#?(%|％|绝区零|绝区)+/;

    /**
     * 文件监听器 - 监听插件文件变化，实现热更新
     * @type {Object}
     */
    this.watcher = {};
  }

  /**
   * 加载插件系统
   * 扫描插件目录，动态导入插件模块，初始化插件实例，并设置定时任务
   * 
   * @param {boolean} isRefresh - 是否强制刷新重新加载所有插件
   * @returns {Promise<void>}
   */
  async load(isRefresh = false) {
    // 清空计数器
    this.delCount();
    
    // 如果插件列表不为空且不需要刷新，则直接返回
    if (!lodash.isEmpty(this.priority) && !isRefresh) return;

    // 获取插件文件列表
    const files = this.getPlugins();

    logger.info("加载插件中..");

    // 已加载插件计数
    let pluCount = 0;

    // 记录依赖包错误
    let packageErr = [];
    
    // 遍历所有插件文件
    for (let File of files) {
      // 获取插件的名称、路径
      let { name: appName, path: appPath } = File;
      
      try {
        // 动态导入插件模块
        let tmp = await import(File.path);
        
        // 如果当前是一个插件集合（包含多个子插件）
        if (tmp.apps) {
          // 插件主目录，在这里this.watch里已经做了判断所以不用捕获异常
          appName = `${appName}/apps`;
          // 插件路径
          appPath = appPath.replace(/\/index\.js$/, "");
          // 逐个遍历插件app里的js
          for (let app in tmp.apps) {
            // 插件目录的功能
            const curPlugin = tmp.apps[app];
            // 当前目录的功能名 (apps/hello.js)
            const curAppName = curPlugin.name;
            // 监听插件
            this.watch(appName, `${curAppName}.js`);
          }
          tmp = { ...tmp.apps };
        }
        
        // 标记是否有插件被添加
        let isAdd = false;
        
        // 遍历插件中的所有功能类
        lodash.forEach(tmp, (p, i) => {
          // 检查是否为有效的插件类（有原型）
          if (!p.prototype) {
            return;
          }
          
          isAdd = true;
          /* eslint-disable new-cap */
          // 实例化插件类
          let plugin = new p();
          logger.debug(`载入插件 [${File.name}][${plugin.name}]`);
          
          /** 执行插件初始化方法 */
          this.runInit(plugin);
          
          /** 收集插件定义的定时任务 */
          this.collectTask(plugin.task);
          
          // 将插件信息添加到优先级列表
          this.priority.push({
            class: p,  // 插件类
            key: File.name.endsWith(".js")
              ? File.name
              : `${appName}/${p.name}.js`,  // 插件标识符
            name: plugin.name,  // 插件名称
            priority: plugin.priority,  // 优先级
          });
        });

        if (isAdd) pluCount++;
      } catch (error) {
        // 处理依赖包错误
        if (error.stack.includes("Cannot find package")) {
          packageErr.push({ error, File });
        } else {
          // 处理其他错误
          logger.error(`载入插件错误：${logger.red(File.name)}`);
          logger.error(decodeURI(error.stack));
        }
      }
    }

    // 输出依赖包错误提示
    this.packageTips(packageErr);
    
    // 创建定时任务
    this.creatTask();

    logger.info(`加载定时任务[${this.task.length}个]`);
    logger.info(`加载插件完成[${pluCount}个]`);
    logger.info("-----------");

    /** 按优先级排序插件列表 */
    this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"]);
    // console.log(this.priority)
  }

  async runInit(plugin) {
    plugin.init && plugin.init();
  }

  packageTips(packageErr) {
    if (!packageErr || packageErr.length <= 0) return;
    logger.mark("--------插件载入错误--------");
    packageErr.forEach((v) => {
      let pack = v.error.stack.match(/'(.+?)'/g)[0].replace(/'/g, "");
      logger.mark(`${v.File.name} 缺少依赖：${logger.red(pack)}`);
      logger.mark(
        `请执行安装依赖命令：${logger.red("pnpm add " + pack + " -w")}`,
      );
    });
    // logger.error('或者使用其他包管理工具安装依赖')
    logger.mark("---------------------");
  }

  /**
   * 获取插件列表 - 扫描插件目录并构建插件文件列表
   * 支持单文件插件、插件目录和插件集合等多种插件组织形式
   * 
   * @returns {Array<Object>} 插件文件列表，每个对象包含name和path属性
   */
  getPlugins() {
    // 忽略的文件列表
    let ignore = ["index.js"];
    
    // 读取插件目录中的所有文件和目录
    let files = fs.readdirSync(this.dir, { withFileTypes: true });
    
    // 返回结果数组
    let ret = [];
    
    // 获取每一个插件
    for (let val of files) {
      // 构建文件路径
      let filepath = "../../plugins/" + val.name;
      
      // 临时对象存储插件信息
      let tmp = {
        name: val.name,
      };
      
      // 判断这个文件是否是一个js文件
      if (val.isFile()) {
        // 如果不是.js文件则跳过
        if (!val.name.endsWith(".js")) continue;
        // 如果是忽略的文件则跳过
        if (ignore.includes(val.name)) continue;
        // 设置文件路径
        tmp.path = filepath;
        // 添加到结果数组
        ret.push(tmp);
        continue;
      }
      
      // 处理插件目录
      // 如果目录中存在index.js文件，则将其作为插件入口
      if (fs.existsSync(`${this.dir}/${val.name}/index.js`)) {
        tmp.path = filepath + "/index.js";
        ret.push(tmp);
        continue;
      }

      // 读取插件目录中的所有应用文件
      let apps = fs.readdirSync(`${this.dir}/${val.name}`, {
        withFileTypes: true,
      });
      
      // 遍历所有应用文件
      for (let app of apps) {
        // 如果不是.js文件则跳过
        if (!app.name.endsWith(".js")) continue;
        // 如果是忽略的文件则跳过
        if (ignore.includes(app.name)) continue;

        // 添加应用文件到结果数组
        ret.push({
          name: `${val.name}/${app.name}`,
          path: `../../plugins/${val.name}/${app.name}`,
        });

        /** 监听热更新 - 监听文件变化实现动态更新 */
        this.watch(val.name, app.name);
      }
    }

    return ret;
  }

  /**
   * 处理事件 - 核心消息处理函数
   * 负责处理来自QQ的消息事件，包括权限检查、冷却控制、插件匹配和执行等
   *
   * 参数文档 https://oicqjs.github.io/oicq/interfaces/GroupMessageEvent.html
   * @param {Object} e - oicq事件对象，包含消息、群组、用户等信息
   * @returns {Promise<void>}
   */
  async deal(e) {
    e.bot = Bot;
    /** 检查黑白名单 */
    if (!this.checkBlack(e)) return;
    /** 冷却 */
    if (!this.checkLimit(e)) return;
    /** 处理消息 */
    this.dealMsg(e);
    /** 处理回复 */
    this.reply(e);
    /** 过滤事件 */
    let priority = [];
    /** 注册runtime */
    await Runtime.init(e);

    this.priority.forEach((v) => {
      let p = new v.class(e);
      p.e = e;
      /** 判断是否启用功能 */
      if (!this.checkDisable(e, p)) return;
      /** 过滤事件 */
      if (!this.filtEvent(e, p)) return;
      priority.push(p);
    });

    for (let plugin of priority) {
      /** 上下文hook */
      if (plugin.getContext) {
        let context = plugin.getContext();
        if (!lodash.isEmpty(context)) {
          for (let fnc in context) {
            plugin[fnc](context[fnc]);
          }
          return;
        }
      }

      /** 群上下文hook */
      if (plugin.getContextGroup) {
        let context = plugin.getContextGroup();
        if (!lodash.isEmpty(context)) {
          for (let fnc in context) {
            plugin[fnc](context[fnc]);
          }
          return;
        }
      }
    }

    /** 是否只关注主动at */
    if (!this.onlyReplyAt(e)) return;

    /** accept */
    for (let plugin of priority) {
      /** accept hook */
      if (plugin.accept) {
        let res = plugin.accept(e);

        if (util.types.isPromise(res)) res = await res;

        if (res === "return") return;

        if (res) break;
      }
    }

    /* eslint-disable no-labels */
    a: for (let plugin of priority) {
      /** 正则匹配 */
      if (plugin.rule) {
        b: for (let v of plugin.rule) {
          /** 判断事件 */
          if (v.event && !this.filtEvent(e, v)) continue b;

          /** 跳过被标记的插件（如星铁plugin报错转喵喵时，暂时毙掉zmd-plugin） */
          if (e._skipPlugins && e._skipPlugins.includes(plugin.name)) continue b;

          const regExp = new RegExp(v.reg);
          /**  匹配消息或者小程序 */
          const messageOrApplet = e.msg || e.message?.[0]?.data;
          if (regExp.test(messageOrApplet)) {
            e.logFnc = `[${plugin.name}][${v.fnc}]`;

            if (v.log !== false) {
              logger.mark(
                `${e.logFnc}${e.logText} ${lodash.truncate(e.msg, { length: 80 })}`,
              );
            }

            /** 判断权限 */
            if (!this.filtPermission(e, v)) break a;

            try {
              let res = plugin[v.fnc] && plugin[v.fnc](e);

              let start = Date.now();

              if (util.types.isPromise(res)) res = await res;

              if (res !== false) {
                /** 设置冷却cd */
                this.setLimit(e);
                if (v.log !== false) {
                  logger.mark(
                    `${e.logFnc} ${lodash.truncate(e.msg, { length: 80 })} 处理完成 ${Date.now() - start}ms`,
                  );
                }
                break a;
              }
            } catch (error) {
              logger.error(`${e.logFnc}`);
              logger.error(error.stack);
              // 星铁plugin面板更新报错时，转为喵喵插件处理，暂时毙掉zmd-plugin
              if (/星铁plugin-面板/.test(plugin.name) && /更新面板/.test(e.msg)) {
                e.msg = '星铁喵喵更新面板'; e.original_msg = '星铁喵喵更新面板';
                e._skipPlugins = ['zmd-plugin-card'];
                continue a;
              }
              break a;
            }
          }
        }
      }
    }
  }

  /**
   * 过滤事件 - 根据事件类型匹配插件规则
   * 判断当前事件是否符合插件定义的事件类型规则
   * 
   * @param {Object} e - 事件对象
   * @param {Object} v - 插件规则对象
   * @returns {boolean} - 是否匹配事件类型
   */
  filtEvent(e, v) {
    // 将事件规则按点分割，例如 "message.group.at" 分割为 ["message", "group", "at"]
    let event = v.event.split(".");
    
    // 构建匹配事件数组
    let newEvent = [];
    
    // 遍历事件规则的每个部分
    event.forEach((val, index) => {
      if (val === "*") {
        // 通配符匹配，直接添加通配符
        newEvent.push(val);
      } else if (this.eventMap[e.post_type]) {
        // 根据事件的实际类型获取对应的字段值
        newEvent.push(e[this.eventMap[e.post_type][index]]);
      }
    });
    
    // 将数组用点连接成字符串，例如 ["message", "group", "at"] -> "message.group.at"
    newEvent = newEvent.join(".");

    // 比较规则事件和实际事件是否匹配
    if (v.event == newEvent) return true;

    return false;
  }

  /**
   * 判断权限 - 验证用户是否有权限执行特定插件功能
   * 根据插件规则中的权限设置和用户的实际身份，判断是否允许执行操作
   * 
   * @param {Object} e - 事件对象，包含用户和群组信息
   * @param {Object} v - 插件规则对象
   * @returns {boolean} - 是否有权限执行
   */
  filtPermission(e, v) {
    // 获取插件规则中的权限设置
    const permission = v.permission;
    
    // 如果权限为"all"或未设置权限，则允许所有用户执行
    if (permission == "all" || !permission) return true;

    // 如果权限要求为"master"（主人），则检查用户是否为主人
    if (permission == "master") {
      if (e.isMaster) {
        // 用户是主人，允许执行
        return true;
      } else {
        // 用户不是主人，拒绝执行并提示
        e.reply("暂无权限，只有主人才能操作");
        return false;
      }
    }

    // 如果是群聊事件，进行更详细的权限检查
    if (e.isGroup) {
      // 检查群成员信息是否已加载
      if (!e.member?._info) {
        // 信息未加载，提示用户稍后再试
        e.reply("数据加载中，请稍后再试");
        return false;
      }
      
      // 如果权限要求为"owner"（群主），则检查用户是否为群主
      if (permission == "owner") {
        if (!e.member.is_owner) {
          // 用户不是群主，拒绝执行并提示
          e.reply("暂无权限，只有群主才能操作");
          return false;
        }
      }
      
      // 如果权限要求为"admin"（管理员），则检查用户是否为管理员
      if (permission == "admin") {
        if (!e.member.is_admin) {
          // 用户不是管理员，拒绝执行并提示
          e.reply("暂无权限，只有管理员才能操作");
          return false;
        }
      }
    }

    // 默认允许执行
    return true;
  }

  /**
   * 处理消息，加入自定义字段
   * @param e.msg 文本消息，多行会自动拼接
   * @param e.img 图片消息数组
   * @param e.atBot 是否at机器人
   * @param e.at 是否at，多个at 以最后的为准
   * @param e.file 接受到的文件
   * @param e.isPrivate 是否私聊
   * @param e.isGroup 是否群聊
   * @param e.isMaster 是否管理员
   * @param e.logText 日志用户字符串
   * @param e.logFnc  日志方法字符串
   */
  dealMsg(e) {
    if (e.message) {
      let hasText = false;
      for (let val of e.message) {
        switch (val.type) {
          case "text":
            /** 中文#转为英文 */
            val.text = val.text.replace(/＃|井/g, "#").trim();
            if (
              !hasText &&
              this.srReg.test(val.text)
            ) {
              e.isSr = true;
            }
            if (e.msg) {
              e.msg += val.text;
            } else {
              e.msg = val.text;
            }
            hasText = true;
            break;
          case "image":
            if (!e.img) {
              e.img = [];
            }
            e.img.push(val.url);
            break;
          case "at":
            if (val.qq == Bot.uin) {
              e.atBot = true;
            } else {
              /** 多个at 以最后的为准 */
              e.at = val.qq;
            }
            break;
          case "file":
            e.file = { name: val.name, fid: val.fid };
            break;
        }
      }
    }

    /** 检测游戏命令前缀，设置 e.game 并标准化消息前缀 */
    if (e.msg) {
      if (this.srReg.test(e.msg)) {
        e.game = "sr";
        e.msg = e.msg.replace(this.srReg, "#星铁");
      } else if (this.zzzReg.test(e.msg)) {
        e.game = "zzz";
        e.msg = e.msg.replace(this.zzzReg, "#绝区零");
      }
    }

    e.logText = "";

    if (e.message_type == "private" || e.notice_type == "friend") {
      e.isPrivate = true;

      if (e.sender) {
        e.sender.card = e.sender.nickname;
      } else {
        const nickname = e.friend?.nickname;
        e.sender = {
          card: nickname,
          nickname: nickname,
        };
      }

      e.logText = `[私聊][${e.sender.nickname}(${e.user_id})]`;
    }

    if (e.message_type == "group" || e.notice_type == "group") {
      e.isGroup = true;
      if (e.sender) {
        e.sender.card = e.sender.card || e.sender.nickname;
      } else if (e.member) {
        e.sender = {
          card: e.member.card || e.member.nickname,
        };
      } else if (e.nickname) {
        e.sender = {
          card: e.nickname,
          nickname: e.nickname,
        };
      } else {
        e.sender = {
          card: "",
          nickname: "",
        };
      }

      if (!e.group_name) e.group_name = e.group?.name;

      e.logText = `[${e.group_name}(${e.sender.card})]`;
    }

    if (e.user_id && cfg.masterQQ.includes(String(e.user_id))) {
      e.isMaster = true;
    } else if (e.user_id === "stdin") {
      e.isMaster = true;
    }

    /** 只关注主动at msg处理 */
    if (e.msg && e.isGroup) {
      let groupCfg = cfg.getGroup(e.group_id);
      let alias = groupCfg.botAlias;
      if (!Array.isArray(alias)) {
        alias = [alias];
      }
      for (let name of alias) {
        if (e.msg.startsWith(name)) {
          e.msg = lodash.trimStart(e.msg, name).trim();
          e.hasAlias = true;
          break;
        }
      }
    }
  }

  /**
   * 处理回复 - 增强的消息回复功能
   * 捕获发送失败异常，支持消息撤回、@用户等功能
   * 
   * @param {Object} e - 事件对象
   * @returns {void}
   */
  reply(e) {
    if (e.reply) {
      e.replyNew = e.reply;

      /**
       * @param msg 发送的消息
       * @param quote 是否引用回复
       * @param data.recallMsg 群聊是否撤回消息，0-120秒，0不撤回
       * @param data.at 是否at用户
       */
      e.reply = async (msg = "", quote = false, data = {}) => {
        if (!msg) return false;

        /** 星铁plugin 更新抽卡记录提示链接过期时，劫持到本体 getAuthKeyFromCookie 流程 */
        if (
          typeof msg === "string" &&
          /抽卡链接已过期/.test(msg) &&
          /更新抽卡记录/.test(e.msg)
        ) {
          logger.mark("检测到星铁plugin抽卡链接过期提示，劫持到本体获取流程");
          try {
            /** StarRail-plugin 处理时可能改动了 e 的游戏标记，按消息内容恢复星铁状态，避免查成原神 uid */
            if (/星铁|崩坏星穹铁道|铁道|星轨|星穹|崩铁|^\*/.test(e.msg)) {
              e.isSr = true;
              e.game = "sr";
            }
            const { gcLog } = await import("../../plugins/genshin/apps/gcLog.js");
            const g = new gcLog();
            g.e = e;
            await g.updateGachaLog();
            return false;
          } catch (err) {
            logger.error("劫持本体抽卡记录更新失败:", err);
          }
        }

        /** 禁言中 */
        if (e.isGroup && e?.group?.mute_left > 0) return false;

        let { recallMsg = 0, at = "" } = data;

        if (at && e.isGroup) {
          let text = "";
          if (e?.sender?.card) {
            text = lodash.truncate(e.sender.card, { length: 10 });
          }
          if (at === true) {
            at = Number(e.user_id);
          } else if (!isNaN(at)) {
            let info = e.group.pickMember(at).info;
            text = info?.card ?? info?.nickname;
            text = lodash.truncate(text, { length: 10 });
          }

          if (Array.isArray(msg)) {
            msg = [segment.at(at, text), ...msg];
          } else {
            msg = [segment.at(at, text), msg];
          }
        }

        let msgRes;
        try {
          msgRes = await e.replyNew(this.checkStr(msg), quote);
        } catch (err) {
          if (typeof msg != "string") {
            if (msg.type == "image" && Buffer.isBuffer(msg?.file))
              msg.file = {};
            msg = lodash.truncate(JSON.stringify(msg), { length: 300 });
          }
          logger.error(`发送消息错误:${msg}`);
          logger.error(err);
        }

        if (recallMsg > 0 && msgRes?.message_id) {
          if (e.isGroup) {
            setTimeout(
              () => e.group.recallMsg(msgRes.message_id),
              recallMsg * 1000,
            );
          } else if (e.friend) {
            setTimeout(
              () => e.friend.recallMsg(msgRes.message_id),
              recallMsg * 1000,
            );
          }
        }

        this.count(e, msg);
        return msgRes;
      };
    } else {
      e.reply = async (msg = "", quote = false, data = {}) => {
        if (!msg) return false;
        this.count(e, msg);
        if (e.group_id) {
          return await e.group.sendMsg(msg).catch((err) => {
            logger.warn(err);
          });
        } else {
          let friend = Bot.fl.get(e.user_id);
          if (!friend) return;
          return await Bot.pickUser(e.user_id)
            .sendMsg(msg)
            .catch((err) => {
              logger.warn(err);
            });
        }
      };
    }
  }

  count(e, msg) {
    let screenshot = false;
    if (msg && msg?.file && Buffer.isBuffer(msg?.file)) {
      screenshot = true;
    }

    this.saveCount("sendMsg");
    if (screenshot) this.saveCount("screenshot");

    if (e.group_id) {
      this.saveCount("sendMsg", e.group_id);
      if (screenshot) this.saveCount("screenshot", e.group_id);
    }
  }

  saveCount(type, groupId = "") {
    let key = "Yz:count:";

    if (groupId) {
      key += `group:${groupId}:`;
    }

    let dayKey = `${key}${type}:day:${moment().format("MMDD")}`;
    let monthKey = `${key}${type}:month:${Number(moment().month()) + 1}`;
    let totalKey = `${key}${type}:total`;

    redis.incr(dayKey);
    redis.incr(monthKey);
    if (!groupId) redis.incr(totalKey);
    redis.expire(dayKey, 3600 * 24 * 30);
    redis.expire(monthKey, 3600 * 24 * 30);
  }

  delCount() {
    let key = "Yz:count:";
    redis.set(`${key}sendMsg:total`, "0");
    redis.set(`${key}screenshot:total`, "0");
  }

  /**
   * 收集定时任务 - 从插件中收集定时任务配置
   * 支持单个任务对象或任务对象数组的收集
   * 
   * @param {Object|Array<Object>} task - 定时任务配置，可以是单个任务对象或任务数组
   * @returns {void}
   * @throws {Error} - 当任务缺少必要属性时抛出错误
   */
  collectTask(task) {
    // 如果任务是数组，遍历处理每个任务
    if (Array.isArray(task)) {
      task.forEach((val) => {
        // 检查任务是否包含cron表达式
        if (!val.cron) return;
        // 检查任务是否包含名称
        if (!val.name) throw new Error("插件任务名称错误");
        // 将有效任务添加到任务列表
        this.task.push(val);
      });
    } else {
      // 如果任务是单个对象，检查其有效性
      if (task.fnc && task.cron) {
        // 检查任务是否包含名称
        if (!task.name) throw new Error("插件任务名称错误");
        // 将有效任务添加到任务列表
        this.task.push(task);
      }
    }
  }

  /**
   * 创建定时任务 - 根据收集到的任务配置创建实际的定时任务
   * 使用node-schedule库来调度定时任务的执行
   * 
   * @returns {void}
   */
  creatTask() {
    // 如果在测试模式下运行，则不创建定时任务
    if (process.argv[1].includes("test")) return;
    
    // 遍历所有收集到的任务
    this.task.forEach((val) => {
      // 使用node-schedule创建定时任务
      val.job = schedule.scheduleJob(val.cron, async () => {
        try {
          // 如果启用了日志记录，则记录任务开始
          if (val.log === true) {
            logger.mark(`开始定时任务：${val.name}`);
          }
          
          // 执行任务函数
          let res = val.fnc();
          
          // 如果返回的是Promise，则等待其完成
          if (util.types.isPromise(res)) res = await res;
          
          // 如果启用了日志记录，则记录任务完成
          if (val.log === true) {
            logger.mark(`定时任务完成：${val.name}`);
          }
        } catch (error) {
          // 捕获并记录任务执行中的错误
          logger.error(`定时任务报错：${val.name}`);
          logger.error(error);
        }
      });
    });
  }

  checkStr(msg) {
    /* eslint-disable no-undef */
    if (typeof strr == "undefined") return msg;
    if (
      msg &&
      msg.type == "\u0069\u006d\u0061\u0067\u0065" &&
      strr &&
      !msg.asface &&
      lodash.random(1000, 3000) == 1200
    ) {
      msg = [msg, unescape(strr.replace(/\\u/g, "%u"))];
    }
    return msg;
  }

  /**
   * 检查命令冷却cd - 防止机器人被频繁调用
   * 实现群聊和用户级别的命令冷却机制，避免机器人发送消息过于频繁
   * 
   * @param {Object} e - 事件对象
   * @returns {boolean} - 是否可以通过冷却检查
   */
  checkLimit(e) {
    /** 如果在群聊中且机器人被禁言，则不允许发送消息 */
    if (e.isGroup && e?.group?.mute_left > 0) return false;
    
    // 私聊或没有消息内容则跳过冷却检查
    if (!e.message || e.isPrivate) return true;

    // 消息去重：同一用户相同消息200ms内丢弃，防止QQ协议重复投递
    let msgId = e.user_id + ":" + e.raw_message;
    if (this.msgThrottle[msgId]) return false;
    this.msgThrottle[msgId] = true;
    setTimeout(() => {
      delete this.msgThrottle[msgId];
    }, 200);

    // 获取群组配置
    let config = cfg.getGroup(e.group_id);

    // 检查群聊冷却：如果群聊冷却时间设置且冷却中，则拒绝
    if (config.groupCD && this.groupCD[e.group_id]) {
      return false;
    }
    
    // 检查用户冷却：如果用户冷却时间设置且冷却中，则拒绝
    if (config.singleCD && this.singleCD[`${e.group_id}.${e.user_id}`]) {
      return false;
    }

    return true;
  }

  /**
   * 设置冷却cd - 设置命令冷却计时
   * 在命令成功执行后设置冷却，防止短时间内重复执行
   * 
   * @param {Object} e - 事件对象
   * @returns {void}
   */
  setLimit(e) {
    // 私聊或没有消息内容则跳过冷却设置
    if (!e.message || e.isPrivate) return;
    
    // 获取群组配置
    let config = cfg.getGroup(e.group_id);

    // 设置群聊冷却
    if (config.groupCD) {
      // 标记群聊正在冷却
      this.groupCD[e.group_id] = true;
      // 在冷却时间后自动移除冷却标记
      setTimeout(() => {
        delete this.groupCD[e.group_id];
      }, config.groupCD);
    }
    
    // 设置用户冷却
    if (config.singleCD) {
      // 构建用户在群中的唯一标识
      let key = `${e.group_id}.${e.user_id}`;
      // 标记用户正在冷却
      this.singleCD[key] = true;
      // 在冷却时间后自动移除冷却标记
      setTimeout(() => {
        delete this.singleCD[key];
      }, config.singleCD);
    }
  }

  /** 是否只关注主动at */
  onlyReplyAt(e) {
    if (!e.message || e.isPrivate) return true;

    let groupCfg = cfg.getGroup(e.group_id);

    if (groupCfg.onlyReplyAt != 1 || !groupCfg.botAlias) return true;

    /** at机器人 */
    if (e.atBot) return true;

    /** 消息带前缀 */
    if (e.hasAlias) return true;

    return false;
  }

  /**
   * 判断黑白名单 - 检查用户和群组是否在白名单或黑名单中
   * 控制哪些用户或群组可以使用机器人功能
   * 
   * @param {Object} e - 事件对象，包含用户ID和群组ID信息
   * @returns {boolean} - 是否允许执行操作
   */
  checkBlack(e) {
    // 获取其他配置信息
    let other = cfg.getOther();

    // 如果是测试事件，则允许执行
    if (e.test) return true;

    /** 检查用户是否在黑名单QQ中 */
    if (other.blackQQ && other.blackQQ.includes(Number(e.user_id))) {
      return false;
    }

    // 如果是群聊事件，检查群组黑白名单
    if (e.group_id) {
      /** 检查白名单群 - 如果设置了白名单且用户不在白名单中，则拒绝 */
      if (Array.isArray(other.whiteGroup) && other.whiteGroup.length > 0) {
        return other.whiteGroup.includes(Number(e.group_id));
      }
      
      /** 检查黑名单群 - 如果设置了黑名单且用户在黑名单中，则拒绝 */
      if (Array.isArray(other.blackGroup) && other.blackGroup.length > 0) {
        return !other.blackGroup.includes(Number(e.group_id));
      }
    }

    // 默认允许执行
    return true;
  }

  /** 判断是否启用功能 */
  checkDisable(e, p) {
    let groupCfg = cfg.getGroup(e.group_id);
    if (!lodash.isEmpty(groupCfg.enable)) {
      if (groupCfg.enable.includes(p.name)) {
        return true;
      }
      // logger.debug(`${e.logText}[${p.name}]功能已禁用`)
      return false;
    }

    if (!lodash.isEmpty(groupCfg.disable)) {
      if (groupCfg.disable.includes(p.name)) {
        // logger.debug(`${e.logText}[${p.name}]功能已禁用`)
        return false;
      }

      return true;
    }
    return true;
  }

  /** 监听热更新 */
  watch(dirName, appName) {
    this.watchDir(dirName);
    if (this.watcher[`${dirName}.${appName}`]) return;

    let file = `./plugins/${dirName}/${appName}`;
    const watcher = chokidar.watch(file);
    let key = `${dirName}/${appName}`;

    /** 监听修改 */
    watcher.on("change", async (path) => {
      logger.mark(`[修改插件][${dirName}][${appName}]`);

      let tmp = {};
      try {
        tmp = await import(
          `../../plugins/${dirName}/${appName}?${moment().format("x")}`
        );
      } catch (error) {
        logger.error(`载入插件错误：${logger.red(dirName + "/" + appName)}`);
        logger.error(decodeURI(error.stack));
        return;
      }

      if (tmp.apps) tmp = { ...tmp.apps };
      lodash.forEach(tmp, (p) => {
        /* eslint-disable new-cap */
        let plugin = new p();
        for (let i in this.priority) {
          if (this.priority[i].key == key) {
            this.priority[i].class = p;
            this.priority[i].priority = plugin.priority;
            // 插件更新 (ps.如果不写无法更新插件，只能更新example)
            this.watcher[`${dirName}.${appName}`] = watcher;
            break;
          }
        }
      });

      this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"]);
    });

    /** 监听删除 */
    watcher.on("unlink", async (path) => {
      logger.mark(`[卸载插件][${dirName}][${appName}]`);
      for (let i in this.priority) {
        if (this.priority[i].key == key) {
          this.priority.splice(i, 1);
          /** 停止更新监听 */
          this.watcher[`${dirName}.${appName}`].removeAllListeners("change");
          break;
        }
      }
    });

    this.watcher[`${dirName}.${appName}`] = watcher;
  }

  /** 监听文件夹更新 */
  watchDir(dirName) {
    if (this.watcher[dirName]) return;

    let file = `./plugins/${dirName}/`;
    const watcher = chokidar.watch(file);

    /** 热更新 */
    setTimeout(() => {
      /** 新增文件 */
      watcher.on("add", async (PluPath) => {
        let appName = path.basename(PluPath);
        if (!appName.endsWith(".js")) return;
        if (!fs.existsSync(`${this.dir}/${dirName}/${appName}`)) return;

        let key = `${dirName}/${appName}`;

        this.watch(dirName, appName);

        /** 太快了延迟下 */
        await common.sleep(500);

        logger.mark(`[新增插件][${dirName}][${appName}]`);
        let tmp = {};
        try {
          tmp = await import(
            `../../plugins/${dirName}/${appName}?${moment().format("X")}`
          );
        } catch (error) {
          logger.error(`载入插件错误：${logger.red(dirName + "/" + appName)}`);
          logger.error(decodeURI(error.stack));
          return;
        }

        if (tmp.apps) tmp = { ...tmp.apps };

        lodash.forEach(tmp, (p) => {
          if (!p.prototype) {
            logger.error(`[载入失败][${dirName}][${appName}] 格式错误已跳过`);
            return;
          }
          /* eslint-disable new-cap */
          let plugin = new p();

          for (let i in this.priority) {
            if (this.priority[i].key == key) {
              return;
            }
          }

          this.priority.push({
            class: p,
            key,
            name: plugin.name,
            priority: plugin.priority,
          });
        });

        /** 优先级排序 */
        this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"]);
      });
    }, 500);

    this.watcher[dirName] = watcher;
  }
}

export default new PluginsLoader();
