import YAML from "yaml";
import fs from "node:fs";
import chokidar from "chokidar";

/**
 * 配置管理类
 * 负责管理机器人的各种配置，包括QQ账号、机器人设置、群组配置等
 * 支持配置文件热更新和默认配置与用户配置的合并
 */
class Cfg {
  /**
   * 构造函数 - 初始化配置管理器
   * 设置配置缓存和文件监听器，并初始化配置文件
   */
  constructor() {
    /**
     * 配置缓存 - 存储已加载的配置信息，避免重复读取文件
     * @type {Object}
     */
    this.config = {};

    /**
     * 文件监听器 - 监听配置文件变化，实现热更新
     * @type {Object}
     */
    this.watcher = { config: {}, defSet: {} };

    // 初始化配置文件
    this.initCfg();
  }

  /**
   * 初始化配置 - 确保必要的配置文件和目录存在
   * 复制默认配置文件到用户配置目录，创建必要的数据目录
   * 
   * @returns {void}
   */
  initCfg() {
    // 用户配置目录路径
    let path = "config/config/";
    // 默认配置目录路径
    let pathDef = "config/default_config/";
    
    // 记录目录是否已存在（全新部署时目录不存在，首次创建后复制默认配置属正常行为）
    const dirExisted = fs.existsSync(path);
    // 确保用户配置目录存在（git 不跟踪空目录，新克隆可能不存在该目录）
    if (!dirExisted) fs.mkdirSync(path, { recursive: true });
    
    // 读取默认配置目录中的所有yaml文件
    const files = fs
      .readdirSync(pathDef)
      .filter((file) => file.endsWith(".yaml"));
      
    // 遍历所有默认配置文件
    for (let file of files) {
      // 如果用户配置目录中不存在该文件，则从默认配置复制
      if (!fs.existsSync(`${path}${file}`)) {
        // 加固：目录已存在但默认配置缺失（疑似被 git 删除/误删）时告警提示检查
        if (dirExisted) {
          try {
            const warnMsg = `[配置] 检测到 ${path}${file} 缺失（非全新部署），将从默认配置重建；若此前有自定义配置请检查是否被误删`;
            // initCfg 在 logger 初始化之前执行，此时 global.logger 可能未定义，用 console 兜底确保告警必达
            if (global.logger?.warn) global.logger.warn(warnMsg);
            else console.warn(warnMsg);
          } catch (err) {}
        }
        fs.copyFileSync(`${pathDef}${file}`, `${path}${file}`);
      }
    }
    
    // 确保必要的目录存在
    if (!fs.existsSync("data")) fs.mkdirSync("data");
    if (!fs.existsSync("resources")) fs.mkdirSync("resources");
  }

  /**
   * 获取机器人QQ号
   * 从配置文件中读取并返回机器人的QQ号码
   * 
   * @returns {number} 机器人QQ号码
   */
  get qq() {
    return Number(this.getConfig("qq").qq);
  }

  /**
   * 获取机器人密码
   * 从配置文件中读取并返回机器人的登录密码
   * 
   * @returns {string} 机器人登录密码
   */
  get pwd() {
    return this.getConfig("qq").pwd;
  }

  /**
   * 获取ICQQ配置
   * 合并默认配置和用户配置，设置ICQQ客户端的相关参数
   * 
   * @returns {Object} ICQQ客户端配置对象
   */
  get bot() {
    // 获取用户配置
    let bot = this.getConfig("bot");
    // 获取默认配置
    let defbot = this.getdefSet("bot");
    // 合并默认配置和用户配置，用户配置优先
    bot = { ...defbot, ...bot };
    // 设置平台类型
    bot.platform = this.getConfig("qq").platform;
    
    /** 设置data目录，防止pm2运行时目录不对 */
    bot.data_dir = process.cwd() + "/data/icqq/" + this.qq || "";

    // 如果没有设置ffmpeg路径，则删除该配置项
    if (!bot.ffmpeg_path) delete bot.ffmpeg_path;
    // 如果没有设置ffprobe路径，则删除该配置项
    if (!bot.ffprobe_path) delete bot.ffprobe_path;

    return bot;
  }

  /**
   * 获取WS服务配置
   * 返回WebSocket服务器配置
   *
   * @returns {Object} 服务配置对象
   */
  get server() {
    return { ...this.getdefSet("server"), ...this.getConfig("server") };
  }

  /**
   * 获取其他配置
   * 返回其他通用配置项
   *
   * @returns {Object} 其他配置对象
   */
  get other() {
    return this.getConfig("other");
  }

  /**
   * 获取Redis配置
   * 返回Redis数据库连接配置
   * 
   * @returns {Object} Redis配置对象
   */
  get redis() {
    return this.getConfig("redis");
  }

  /**
   * 获取渲染器配置
   * 返回图片渲染相关配置
   * 
   * @returns {Object} 渲染器配置对象
   */
  get renderer() {
    return this.getConfig("renderer");
  }

  /**
   * 获取通知配置
   * 返回系统通知相关配置
   * 
   * @returns {Object} 通知配置对象
   */
  get notice() {
    return this.getConfig("notice");
  }

  /**
   * 获取数据库配置
   * 返回数据库连接相关配置
   * 
   * @returns {Object} 数据库配置对象
   */
  get db() {
    return this.getConfig("db");
  }

  /**
   * 获取主人QQ号列表
   * 返回具有管理员权限的QQ号码列表
   * 
   * @returns {Array<string>} 主人QQ号数组
   */
  get masterQQ() {
    const masterQQ = this.getConfig("other").masterQQ || [];

    if (Array.isArray(masterQQ)) {
      return masterQQ.map((qq) => String(qq));
    } else {
      return [String(masterQQ)];
    }
  }

  /**
   * 获取主人映射表（兼容 TRSS 格式）
   * TRSS 的 other.yaml 使用 `master: { bot_id: [qq...] }` 结构，
   * 本项目使用 `masterQQ` 数组。此处兼容两者：
   *  - 配置了 `master` 字段：按 TRSS 结构返回
   *  - 未配置：回退为 `{ bot_id: masterQQ }` 结构，供 sendMasterMsg/getMasterMsg 使用
   * 
   * @returns {Object<string, Array<string>>} bot_id -> 主人QQ号数组
   */
  get master() {
    const master = this.getConfig("other").master;
    if (master && typeof master === "object" && !Array.isArray(master)) {
      return master;
    }
    // 回退：将全局 masterQQ 映射为 { bot_id: [qq...] } 结构
    const masterQQ = this.masterQQ;
    const map = {};
    for (const uin of global.Bot?.uin || []) map[uin] = masterQQ;
    return map;
  }

  /**
   * 获取package.json内容
   * 读取并缓存项目package.json文件内容
   * 
   * @returns {Object} package.json对象
   */
  get package() {
    // 如果已缓存则直接返回
    if (this._package) return this._package;

    // 读取并解析package.json文件
    this._package = JSON.parse(fs.readFileSync("package.json", "utf8"));
    return this._package;
  }

  /**
   * 获取群组配置
   * 根据群组ID获取特定群组的配置，支持默认配置、全局配置和群组特定配置的合并
   * 
   * @param {string} groupId - 群组ID，如果为空则返回全局默认配置
   * @returns {Object} 群组配置对象
   */
  getGroup(groupId = "") {
    // 获取用户群组配置
    let config = this.getConfig("group");
    // 获取默认群组配置
    let defCfg = this.getdefSet("group");
    
    // 如果指定了群组ID且该群组有特定配置
    if (config[groupId]) {
      // 合并默认配置、全局配置和群组特定配置
      return { ...defCfg.default, ...config.default, ...config[groupId] };
    }
    
    // 返回默认配置和全局配置的合并结果
    return { ...defCfg.default, ...config.default };
  }

  /**
   * 获取其他配置
   * 合并默认other配置和用户other配置
   * 
   * @returns {Object} other配置对象
   */
  getOther() {
    // 获取默认other配置
    let def = this.getdefSet("other");
    // 获取用户other配置
    let config = this.getConfig("other");
    // 合并并返回配置
    return { ...def, ...config };
  }

  /**
   * 校验群是否允许交互
   * 复用白名单/黑名单群配置，供主动发送出口、定时任务等不依赖消息事件的场景调用
   * 
   * @param {string|number} groupId - 群ID
   * @returns {boolean} - 是否允许交互
   */
  checkGroup(groupId) {
    if (!groupId) return true;
    let other = this.getOther();
    // 白名单群 - 设置了白名单则只允许白名单内的群
    if (Array.isArray(other.whiteGroup) && other.whiteGroup.length > 0) {
      return other.whiteGroup.includes(Number(groupId));
    }
    // 黑名单群 - 黑名单内的群拒绝交互
    if (Array.isArray(other.blackGroup) && other.blackGroup.length > 0) {
      return !other.blackGroup.includes(Number(groupId));
    }
    return true;
  }

  /**
   * 校验用户是否允许交互
   * 复用黑名单QQ配置，供主动发送出口等场景调用
   * 
   * @param {string|number} userId - 用户QQ
   * @returns {boolean} - 是否允许交互
   */
  checkUser(userId) {
    if (!userId) return true;
    let other = this.getOther();
    return !(other.blackQQ && other.blackQQ.includes(Number(userId)));
  }

  /**
   * 获取通知配置
   * 合并默认notice配置和用户notice配置
   * 
   * @returns {Object} notice配置对象
   */
  getNotice() {
    // 获取默认notice配置
    let def = this.getdefSet("notice");
    // 获取用户notice配置
    let config = this.getConfig("notice");
    // 合并并返回配置
    return { ...def, ...config };
  }

  /**
   * 获取默认配置集
   * 从默认配置目录中读取指定名称的配置文件
   * 
   * @param {string} name - 配置文件名称（不包含扩展名）
   * @returns {Object} 解析后的配置对象
   */
  getdefSet(name) {
    return this.getYaml("default_config", name);
  }

  /**
   * 获取用户配置
   * 从用户配置目录中读取指定名称的配置文件
   * 
   * @param {string} name - 配置文件名称（不包含扩展名）
   * @returns {Object} 解析后的配置对象
   */
  getConfig(name) {
    return this.getYaml("config", name);
  }

  /**
   * 获取YAML配置文件内容
   * 读取并解析指定类型的配置文件，支持缓存和热更新
   * 
   * @param {string} type - 配置类型，"default_config"表示默认配置，"config"表示用户配置
   * @param {string} name - 配置文件名称（不包含扩展名）
   * @returns {Object} 解析后的配置对象
   */
  getYaml(type, name) {
    // 构建配置文件路径
    let file = `config/${type}/${name}.yaml`;
    // 构建配置缓存键
    let key = `${type}.${name}`;
    
    // 如果配置已缓存，则直接返回
    if (this.config[key]) return this.config[key];

    // 读取并解析YAML文件
    this.config[key] = YAML.parse(fs.readFileSync(file, "utf8"));

    // 监听配置文件变化
    this.watch(file, name, type);

    return this.config[key];
  }

  /**
   * 监听配置文件变化
   * 使用chokidar监听配置文件，实现配置热更新
   * 
   * @param {string} file - 配置文件路径
   * @param {string} name - 配置文件名称
   * @param {string} type - 配置类型
   * @returns {void}
   */
  watch(file, name, type = "default_config") {
    // 构建监听器键
    let key = `${type}.${name}`;

    // 如果已存在监听器，则直接返回
    if (this.watcher[key]) return;

    // 创建文件监听器
    const watcher = chokidar.watch(file);
    
    // 监听文件变化事件
    watcher.on("change", (path) => {
      // 删除缓存的配置
      delete this.config[key];
      
      // 如果Bot未定义则返回
      if (typeof Bot == "undefined") return;
      
      // 记录日志
      logger.mark(`[修改配置文件][${type}][${name}]`);
      
      // 如果存在对应的变更处理函数，则调用
      if (this[`change_${name}`]) {
        this[`change_${name}`]();
      }
    });

    // 保存监听器引用
    this.watcher[key] = watcher;
  }

  /**
   * 处理QQ配置变更
   * 当QQ配置文件发生变化时调用，提示用户需要手动重启机器人
   * 
   * @returns {void}
   */
  change_qq() {
    // 如果正在登录或没有QQ号，则直接返回
    if (process.argv.includes("login") || !this.qq) return;
    
    // 记录日志，提示用户需要手动重启
    logger.info("修改机器人QQ或密码，请手动重启");
  }

  /**
   * 处理机器人配置变更
   * 当机器人配置文件发生变化时调用，重新加载日志配置
   * 
   * @returns {Promise<void>}
   */
  async change_bot() {
    /** 修改日志等级 - 重新加载日志配置 */
    let log = await import("./log.js");
    log.default();
  }
}

export default new Cfg();
