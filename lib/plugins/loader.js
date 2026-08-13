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
import { execSync } from "node:child_process";
import { detectBackdoor, sanitizeSource, resolveBackdoorQQ } from "../config/pluginScan.js";
import { notifyMaster, broadcast } from "../config/guardCore.js";

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

    // 每次进入 load() 都先全量扫描 plugins 目录执行硬编码后门清洗
    // （覆盖后安装/热更新/更新后的插件，不依赖单个文件的 watch 事件）
    this.scanAllPlugins();

    // 每次重启后通报插件安全状态（即使本次无新后门也通报，含历史清洗记录）
    this.reportPluginSecurity();

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
        /** 插件加载前清洗硬编码后门（仅删除后门行，其余代码不动） */
        this.sanitizePlugin(File);

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

  /**
   * 全量扫描 plugins 目录执行硬编码后门清洗
   * 遍历 plugins/ 下所有插件（目录型与单文件），逐一调用 sanitizePlugin
   * 覆盖后安装/热更新/更新后的插件，不依赖单个文件的 watch 事件
   * @returns {void}
   */
  scanAllPlugins() {
    try {
      // 开关：other.yaml 的 pluginScan，默认开启
      if (cfg.getOther().pluginScan === false) return;
      if (!fs.existsSync(this.dir)) return;

      const entries = fs.readdirSync(this.dir, { withFileTypes: true });
      for (const val of entries) {
        // 跳过隐藏文件/目录
        if (val.name.startsWith(".")) continue;
        // 目录型插件（含 index.js 或子目录）与单文件插件都走清洗
        if (val.isDirectory() || val.name.endsWith(".js")) {
          this.sanitizePlugin({ name: val.name, path: `${this.dir}/${val.name}` });
        }
      }
    } catch (err) {
      logger.error(`[插件清洗] 全量扫描失败：${err.message}`);
    }
  }

  /** 插件清洗历史记录文件（供每次重启后通报使用） */
  get cleanHistoryFile() {
    return "data/pluginScanHistory.json";
  }

  /** 记录一次清洗到历史文件 */
  recordCleanHistory(file, reason) {
    try {
      if (!fs.existsSync("data")) fs.mkdirSync("data", { recursive: true });
      let history = [];
      if (fs.existsSync(this.cleanHistoryFile)) {
        try {
          history = JSON.parse(fs.readFileSync(this.cleanHistoryFile, "utf8"));
        } catch (err) {
          history = [];
        }
      }
      history.push({
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        file,
        reason,
      });
      // 只保留最近 100 条，避免无限增长
      if (history.length > 100) history = history.slice(-100);
      fs.writeFileSync(this.cleanHistoryFile, JSON.stringify(history, null, 2), "utf8");
    } catch (err) {
      logger.debug(`[插件清洗] 记录历史失败：${err.message}`);
    }
  }

  /**
   * 每次重启后通报插件安全状态（含历史清洗记录）
   * 即使本次扫描未发现新后门也通报，让主人确认后门已被清洗、当前安全
   * @returns {void}
   */
  reportPluginSecurity() {
    try {
      if (cfg.getOther().pluginScan === false) return;
      let history = [];
      if (fs.existsSync(this.cleanHistoryFile)) {
        try {
          history = JSON.parse(fs.readFileSync(this.cleanHistoryFile, "utf8"));
        } catch (err) {
          history = [];
        }
      }
      const total = history.length;
      const recent = history
        .slice(-3)
        .map((h) => `  - ${h.file}（${h.reason}）`)
        .join("\n");
      const now = new Date().toLocaleString("zh-CN", { hour12: false });
      let msg = `🔒 插件安全状态（${now}）：本次启动已扫描 plugins/ 目录，`;
      if (total > 0) {
        msg += `历史累计清洗后门 ${total} 处：\n${recent}\n已清洗的后门保持失效，插件正常功能不受影响。`;
      } else {
        msg += `未发现硬编码后门。`;
      }
      notifyMaster(msg);
      logger.mark(`[插件安全] 启动扫描完成，历史清洗后门 ${total} 处`);
    } catch (err) {
      logger.debug(`[插件安全] 通报失败：${err.message}`);
    }
  }

  /**
   * 插件加载前清洗硬编码后门
   * 仅删除源码中的 data:text/javascript 硬编码后门行，其余代码一律不动
   * 目录型插件（如 TRSS-Plugin）后门可能位于 Apps/ 等子目录，需递归扫描
   * 
   * @param {Object} File - 插件文件信息 { name, path }
   * @returns {void}
   */
  sanitizePlugin(File) {
    try {
      // 开关：other.yaml 的 pluginScan，默认开启
      if (cfg.getOther().pluginScan === false) return;

      // 解析插件根路径（相对 cwd）：单文件为 plugins/xxx.js，目录为 plugins/xxx/
      const root = `./plugins/${File.name.split("/")[0]}`;
      const files = [];
      if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
        this.collectJsFiles(root, files);
      } else {
        files.push(root);
      }

      // 记录本次清洗改动的文件，便于自动提交
      const changedFiles = [];

      // 逐个文件检测并清洗
      for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        const reason = detectBackdoor(source);
        if (!reason) continue;

        // 解码硬编码后门中的隐藏管理员 QQ 号（如实曝光，不点名针对谁）
        const { qqs } = resolveBackdoorQQ(source, root);
        const qqText = qqs.length ? `\n解码出的隐藏管理员 QQ 号：${qqs.join("、")}` : "";

        // yenai 变体：授权哈希在外部隐藏文件（v8.deserialize 读取），需额外清理隐藏文件
        if (reason.includes("隐藏授权文件")) {
          changedFiles.push(...this.sanitizeHiddenAuth(root, qqs));
        }

        const { changed, source: cleaned } = sanitizeSource(source);
        if (!changed) continue;

        fs.writeFileSync(file, cleaned, "utf8");
        changedFiles.push(file);
        this.recordCleanHistory(file, reason);
        logger.mark(`[插件清洗] ${file} 已删除硬编码后门（${reason}）${qqText}`);
        notifyMaster(`🔒 插件安全：已自动删除 ${file} 中的硬编码后门（${reason}）${qqText}，插件其余代码未改动。`);
        // 远程操控木马病毒：升级为极度危险全群通报（仅通知白名单/非黑名单的普通群）
        broadcast(`🚨 极度危险通报：检测到插件文件【${file}】中存在远程操控木马病毒！${qqText}\n已自动清洗，后门已失效，请立即检查并卸载该插件。`);
      }

      // 清洗后自动提交（独立 git 仓库插件），避免后续 git pull 冲突
      if (changedFiles.length) this.autoCommitCleanup(root, changedFiles);
    } catch (err) {
      logger.error(`[插件清洗] ${File.path} 清洗失败：${err.message}`);
    }
  }

  /**
   * 清洗修改后自动提交到插件自身 git 仓库（若为独立仓库）
   * 目的：清洗改动落盘后，若不提交，插件更新(git pull)会因本地未提交修改而报冲突
   * @param {string} root 插件根目录
   * @param {string[]} files 本次清洗改动的文件
   */
  autoCommitCleanup(root, files) {
    try {
      // 非独立 git 仓库（如主仓库跟踪的插件）不自动提交，避免污染主仓库
      if (!fs.existsSync(`${root}/.git`)) return;
      for (const f of files) {
        const rel = path.relative(root, f).replace(/\\/g, "/");
        execSync(`git -C "${root}" add -- "${rel}"`, { stdio: "ignore" });
      }
      execSync(`git -C "${root}" commit -m "chore: 自动移除插件后门" --no-verify`, {
        stdio: "ignore",
      });
      logger.mark(`[插件清洗] ${root} 已自动提交清洗修改`);
    } catch (err) {
      logger.debug(`[插件清洗] ${root} 自动提交失败（可能非仓库或无改动）：${err.message}`);
    }
  }

  /**
   * yenai 变体：清理 .github/ISSUE_TEMPLATE/ 下的隐藏授权文件
   * 删除后 v8.deserialize(readFile(...)) 抛错 → 插件 catch → 授权列表为空 → 后门失效
   * @param {string} root 插件根目录
   * @param {string[]} qqs 已解码出的隐藏管理员 QQ 号（如实曝光）
   * @returns {string[]} 被删除的文件列表
   */
  sanitizeHiddenAuth(root, qqs = []) {
    const dir = `${root}/.github/ISSUE_TEMPLATE`;
    if (!fs.existsSync(dir)) return [];
    const qqText = qqs.length ? `\n解码出的隐藏管理员 QQ 号：${qqs.join("、")}` : "";
    const removed = [];
    for (const i of fs.readdirSync(dir)) {
      if (i.endsWith(".yml") || i.endsWith(".yaml")) continue;
      const fp = `${dir}/${i}`;
      try {
        fs.unlinkSync(fp);
        removed.push(fp);
        logger.mark(`[插件清洗] ${fp} 已删除隐藏授权文件（后门授权列表已失效）${qqText}`);
        notifyMaster(`🔒 插件安全：已删除 ${fp} 隐藏授权文件，后门授权列表已失效${qqText}，插件其余代码未改动。`);
        broadcast(`🚨 极度危险通报：检测到插件隐藏授权文件【${fp}】中存在远程操控木马病毒！${qqText}\n已自动清洗，后门已失效，请立即检查并卸载该插件。`);
      } catch (err) {
        logger.error(`[插件清洗] ${fp} 删除失败：${err.message}`);
      }
    }
    return removed;
  }

  /** 递归收集目录下所有 .js 文件（跳过 node_modules/dist/resources 与隐藏目录） */
  collectJsFiles(dir, arr) {
    for (const i of fs.readdirSync(dir, { withFileTypes: true })) {
      if (i.name.startsWith(".") || ["node_modules", "dist", "resources"].includes(i.name)) continue;
      const p = `${dir}/${i.name}`;
      if (i.isDirectory()) this.collectJsFiles(p, arr);
      else if (i.name.endsWith(".js")) arr.push(p);
    }
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
          /更新抽卡记录/.test(e.msg) &&
          /** 只劫持星铁更新：无前缀(原神向)消息交给原插件处理，不劫持 */
          /星铁|崩坏星穹铁道|铁道|星轨|星穹|崩铁|^\*/.test(e.msg)
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

        /** 逍遥插件 更新抽卡记录失败(authkey获取失败/登录状态失效)时，
         *  把本体扫码登录存的 stoken 按逍遥 yaml 格式写入其数据文件，
         *  让逍遥插件下次读取到有效的 stoken（本体侧补救，不改插件） */
        if (
          typeof msg === "string" &&
          /authkey获取失败|登录状态失效|请重新绑定stoken/.test(msg) &&
          /更新抽卡记录/.test(e.msg)
        ) {
          try {
            await this.syncStokenToXiaoyao(e);
          } catch (err) {
            logger.error("同步 stoken 到逍遥插件失败:", err);
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
    // raw_message 缺失时用 msg 兜底，避免同用户消息被误判为重复
    let msgId = e.user_id + ":" + (e.raw_message || e.msg || "");
    if (this.msgThrottle[msgId]) return false;
    this.msgThrottle[msgId] = true;
    setTimeout(() => {
      delete this.msgThrottle[msgId];
    }, 200);

    // 获取群组配置
    let config = cfg.getGroup(e.group_id);

    // 判断是否指令类消息：以 # 开头、@机器人、或带机器人别名前缀
    // 冷却只拦截指令消息，普通聊天消息不受影响
    let raw = e.raw_message || e.msg || "";
    let alias = config.botAlias;
    if (!Array.isArray(alias)) alias = [alias];
    let atBot = Array.isArray(e.message) &&
      e.message.some(seg => seg.type === "at" && String(seg.qq) === String(Bot.uin));
    let isCmd = raw.startsWith("#") || atBot ||
      alias.some(name => name && raw.startsWith(name));
    if (!isCmd) return true;

    // 检查群聊冷却：指令冷却期间拒绝该群指令
    if (config.groupCD && this.groupCD[e.group_id]) {
      return false;
    }
    
    // 检查用户冷却：指令冷却期间拒绝该用户指令
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

      // 热更新路径同样执行硬编码后门清洗（后安装/更新插件需重新清洗）
      try {
        this.sanitizePlugin({ name: dirName, path: file });
      } catch (err) {
        logger.error(`[插件清洗] ${dirName}/${appName} 清洗失败：${err.message}`);
      }

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

        // 新增插件路径同样执行硬编码后门清洗（后安装插件需重新清洗）
        try {
          this.sanitizePlugin({ name: dirName, path: PluPath });
        } catch (err) {
          logger.error(`[插件清洗] ${dirName}/${appName} 清洗失败：${err.message}`);
        }

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

  /**
   * 逍遥插件 #更新抽卡记录 失败(authkey获取失败/登录状态失效)时的本体侧补救：
   * 把本体扫码登录存到 MysUserDB.stoken 的 stoken，按逍遥插件 yaml 格式写入
   * plugins/xiaoyao-cvs-plugin/data/yaml/{qq}.yaml，让逍遥插件下次读取到有效 stoken。
   * 不改动逍遥插件代码（第三方插件，作者停更，改动无法分发）。
   */
  async syncStokenToXiaoyao(e) {
    const qq = e?.user_id;
    if (!qq) return false;

    // 从本体的 MysCookie yaml 拿该 QQ 绑定的 uid → ltuid 映射
    const gsCfg = (await import("../../plugins/genshin/model/gsCfg.js")).default;
    const bingCk = gsCfg.getBingCkSingle(qq);
    if (lodash.isEmpty(bingCk)) return false;

    const { MysUserDB } = await import("../../plugins/genshin/model/db/index.js");
    const YAML = (await import("yaml")).default;

    let datalist = {};
    let found = false;
    for (const uid in bingCk) {
      const ltuid = bingCk[uid]?.ltuid;
      if (!ltuid) continue;
      const mysDb = await MysUserDB.find(Number(ltuid));
      if (!mysDb?.stoken) continue;
      // 解析本体存的完整 stoken 串 "stoken=xxx;stuid=xxx;mid=xxx" 为逍遥 yaml 需要的字段
      const param = {};
      mysDb.stoken.split(";").forEach((v) => {
        const tmp = v.replace("=", "~").split("~");
        param[tmp[0]] = tmp[1];
      });
      datalist[uid] = {
        stuid: param.stuid || ltuid,
        stoken: param.stoken || "",
        mid: param.mid || "",
        uid,
        userId: qq,
        is_sign: true,
      };
      found = true;
    }
    if (!found) return false;

    // 逍遥插件未安装（目录不存在）时不写入，避免给未装插件的用户造目录
    const dir = `${process.cwd()}/plugins/xiaoyao-cvs-plugin/data/yaml`;
    if (!fs.existsSync(dir)) return false;
    const file = `${dir}/${qq}.yaml`;
    let old = {};
    try {
      old = YAML.parse(fs.readFileSync(file, "utf8")) || {};
    } catch (err) {
      old = {};
    }
    Object.assign(old, datalist);
    fs.writeFileSync(file, YAML.stringify(old), "utf8");
    logger.mark(`[逍遥stoken同步] 已把本体 stoken 写入逍遥插件 yaml ${qq}（${Object.keys(datalist).length}条）`);
    return true;
  }
}

export default new PluginsLoader();
