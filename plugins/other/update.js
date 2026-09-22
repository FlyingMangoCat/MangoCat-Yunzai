import plugin from "../../lib/plugins/plugin.js";
import { createRequire } from "module";
import lodash from "lodash";
import fs from "node:fs";
import { Restart } from "./restart.js";
import common from "../../lib/common/common.js";

const require = createRequire(import.meta.url);
const { exec, execSync } = require("child_process");

let uping = false;

export class update extends plugin {
  constructor() {
    super({
      name: "更新",
      dsc: "#更新 #强制更新",
      event: "message",
      priority: 4000,
      rule: [
        {
          reg: "^#更新日志$",
          fnc: "updateLog",
        },
        {
          reg: "^#全部更新$",
          fnc: "updateAll",
          permission: "master",
        },
        {
          reg: "^#(强制)*更新(.*)",
          fnc: "update",
        },
      ],
    });

    this.typeName = "MangoCat-Yunzai";
  }

  async update() {
    if (!this.e.isMaster) return false;
    if (uping) {
      await this.reply("已有命令更新中..请勿重复操作");
      return;
    }

    if (/详细|详情|面板|面版/.test(this.e.msg)) return false;

    /** 获取插件 */
    let plugin = this.getPlugin();

    if (plugin === false) return false;

    /** 检查git安装 */
    if (!(await this.checkGit())) return;

    /** 执行更新 */
    await this.runUpdate(plugin);

    /** 是否需要重启 */
    if (this.isUp) {
      // await this.reply('即将执行重启，以应用更新')
      setTimeout(() => this.restart(), 2000);
    }
  }

  async checkGit() {
    let ret = await execSync("git --version", { encoding: "utf-8" });
    if (!ret || !ret.includes("git version")) {
      await this.reply("请先安装git");
      return false;
    }

    return true;
  }

  getPlugin(plugin = "") {
    if (!plugin) {
      plugin = this.e.msg.replace(/#|更新|强制/g, "");
      if (!plugin) return "";
    }

    let path = `./plugins/${plugin}/.git`;

    if (!fs.existsSync(path)) return false;

    this.typeName = plugin;
    return plugin;
  }

  async execSync(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    });
  }

  /**
   * pull 前暂存本地未提交改动（含插件清洗产生的修改）
   * 目的：工作区有改动时 git pull 会被拒绝,用 stash 暂存而非 commit——
   * 更新只应拉代码,不应在插件仓库里产生任何提交;
   * pull 成功后 stash pop 把改动放回,合并冲突时保留 stash 由用户自行处理。
   * 仅处理有 .git 的独立仓库目录，主仓库跟踪的插件（无 .git）跳过。
   * @param {string} plugin 插件名（空=更新本体主仓库）
   * @returns {Promise<boolean>} 是否执行了 stash
   */
  async preCommit(plugin = "") {
    try {
      const dir = plugin ? `./plugins/${plugin}` : ".";
      if (!fs.existsSync(`${dir}/.git`)) return false;
      const status = await this.execSync(`git -C "${dir}" status --porcelain`);
      if (status.error || !status.stdout.trim()) return false;
      const ret = await this.execSync(`git -C "${dir}" stash push -u -m "更新前暂存"`);
      if (ret.error) {
        logger.debug(`[更新] ${plugin || "本体"} 暂存本地改动失败：${ret.error.message}`);
        return false;
      }
      logger.mark(`[更新] ${plugin || "本体"} 已暂存本地改动，更新后恢复`);
      return true;
    } catch (err) {
      logger.debug(`[更新] ${plugin || "本体"} 暂存本地改动失败：${err.message}`);
      return false;
    }
  }

  /**
   * pull 后恢复 preCommit 暂存的本地改动;冲突时保留 stash 不丢弃
   */
  async postRestore(plugin = "") {
    try {
      const dir = plugin ? `./plugins/${plugin}` : ".";
      if (!fs.existsSync(`${dir}/.git`)) return;
      const stashList = await this.execSync(`git -C "${dir}" stash list`);
      if (stashList.error || !/更新前暂存/.test(stashList.stdout)) return;
      const ret = await this.execSync(`git -C "${dir}" stash pop`);
      if (ret.error) {
        logger.mark(`[更新] ${plugin || "本体"} 恢复暂存改动有冲突，已保留在 stash，可自行处理：git -C ${dir} stash pop`);
        return;
      }
      logger.mark(`[更新] ${plugin || "本体"} 已恢复暂存的本地改动`);
    } catch (err) {
      logger.debug(`[更新] ${plugin || "本体"} 恢复暂存改动失败：${err.message}`);
    }
  }

  async getBranch(plugin = "") {
    const cm = plugin
      ? `git -C ./plugins/${plugin}/ rev-parse --abbrev-ref HEAD`
      : "git rev-parse --abbrev-ref HEAD";
    const ret = await this.execSync(cm);
    return ret.error ? "" : lodash.trim(ret.stdout);
  }

  /**
   * 清理历史自动提交产生的本地领先 commit(仅本工具造成的垃圾):
   * 若本地领先远端的提交全部是"自动提交本地改动",则对齐远端丢弃;
   * 混有其他提交(用户自己的改动)则不动,避免误伤。
   * @param {string} plugin 插件名（空=更新本体主仓库）
   */
  async autoCleanLocalCommits(plugin = "") {
    try {
      const dir = plugin ? `./plugins/${plugin}` : ".";
      if (!fs.existsSync(`${dir}/.git`)) return;
      const branchRet = await this.execSync(`git -C "${dir}" rev-parse --abbrev-ref HEAD`);
      if (branchRet.error || !branchRet.stdout.trim()) return;
      const branch = lodash.trim(branchRet.stdout);
      await this.execSync(`git -C "${dir}" fetch origin`);
      const logRet = await this.execSync(`git -C "${dir}" log origin/${branch}..HEAD --pretty=%s`);
      if (logRet.error || !logRet.stdout.trim()) return;
      const subjects = lodash.trim(logRet.stdout).split("\n");
      // 旧更新链产生的本地垃圾提交:
      //  - "自动提交本地改动"(旧 preCommit 方案)
      //  - "Merge branch ..."(旧 pull --no-rebase 在分叉时自动产生的合并提交)
      // 领先提交里只要有一个不属于上述垃圾,就不动
      const junkRe = /自动提交本地改动|^Merge branch '.*'(?:(?!GitLab|github|gitee).)*$/i;
      if (subjects.some((s) => !junkRe.test(s))) return;
      await this.execSync(`git -C "${dir}" reset --hard origin/${branch}`);
      logger.mark(`[更新] ${plugin || "本体"} 已清理 ${subjects.length} 个历史自动提交/合并残留，对齐远端`);
    } catch (err) {
      logger.debug(`[更新] ${plugin || "本体"} 自动清理本地提交失败：${err.message}`);
    }
  }

  async runUpdate(plugin = "") {
    this.isNowUp = false;

    let cm = "git pull --ff-only";

    let type = "更新";
    const isForce = this.e.msg.includes("强制");
    if (isForce) {
      type = "强制更新";
      // 按实际分支重置(勿写死 origin/main),插件目录需加 -C 前缀
      const branch = (await this.getBranch(plugin)) || "main";
      const gitDir = plugin ? `git -C ./plugins/${plugin}/` : "git";
      cm = `${gitDir} fetch --all && ${gitDir} reset --hard origin/${branch} && ${gitDir} pull --ff-only`;
    }

    if (plugin) {
      cm = `git -C ./plugins/${plugin}/ pull --ff-only`;
    }

    // pull 前暂存本地未提交改动（含插件清洗改动），避免 pull 因本地修改被拒;
    // 强制更新走 reset --hard 会丢弃本地改动，无需暂存
    if (!isForce) await this.autoCleanLocalCommits(plugin);
    let stashed = false;
    if (!isForce) stashed = await this.preCommit(plugin);

    this.oldCommitId = await this.getcommitId(plugin);

    logger.mark(`${this.e.logFnc} 开始${type}：${this.typeName}`);

    await this.reply(`开始#${type}${this.typeName}`);
    uping = true;
    let ret = await this.execSync(cm);
    uping = false;

    if (ret.error) {
      // pull 失败也要把暂存的改动放回,不弄丢用户数据
      if (stashed) await this.postRestore(plugin);
      logger.mark(`${this.e.logFnc} 更新失败：${this.typeName}`);
      this.gitErr(ret.error, ret.stdout);
      return false;
    }

    if (stashed) await this.postRestore(plugin);

    let time = await this.getTime(plugin);

    if (/Already up|已经是最新/g.test(ret.stdout)) {
      await this.reply(`${this.typeName}已经是最新\n最后更新时间：${time}`);
    } else {
      await this.reply(`${this.typeName}更新成功\n更新时间：${time}`);
      this.isUp = true;
      let log = await this.getLog(plugin);
      await this.reply(log);
    }

    logger.mark(`${this.e.logFnc} 最后更新时间：${time}`);

    return true;
  }

  async getcommitId(plugin = "") {
    let cm = "git rev-parse --short HEAD";
    if (plugin) {
      cm = `git -C ./plugins/${plugin}/ rev-parse --short HEAD`;
    }

    let commitId = await execSync(cm, { encoding: "utf-8" });
    commitId = lodash.trim(commitId);

    return commitId;
  }

  async getTime(plugin = "") {
    let cm =
      'git log  -1 --oneline --pretty=format:"%cd" --date=format:"%m-%d %H:%M"';
    if (plugin) {
      cm = `cd ./plugins/${plugin}/ && git log -1 --oneline --pretty=format:"%cd" --date=format:"%m-%d %H:%M"`;
    }

    let time = "";
    try {
      time = await execSync(cm, { encoding: "utf-8" });
      time = lodash.trim(time);
    } catch (error) {
      logger.error(error.toString());
      time = "获取时间失败";
    }

    return time;
  }

  async gitErr(err, stdout) {
    let msg = "更新失败！";
    let errMsg = err.toString();
    stdout = stdout.toString();

    if (errMsg.includes("Timed out")) {
      let remote = errMsg.match(/'(.+?)'/g)[0].replace(/'/g, "");
      await this.reply(msg + `\n连接超时：${remote}`);
      return;
    }

    if (/Failed to connect|unable to access/g.test(errMsg)) {
      let remote = errMsg.match(/'(.+?)'/g)[0].replace(/'/g, "");
      await this.reply(msg + `\n连接失败：${remote}`);
      return;
    }

    if (errMsg.includes("be overwritten by merge")) {
      await this.reply(
        msg +
          `存在冲突：\n${errMsg}\n` +
          "请解决冲突后再更新，或者执行#强制更新，放弃本地修改",
      );
      return;
    }

    if (stdout.includes("CONFLICT")) {
      await this.reply([
        msg + "存在冲突\n",
        errMsg,
        stdout,
        "\n请解决冲突后再更新，或者执行#强制更新，放弃本地修改",
      ]);
      return;
    }

    await this.reply([errMsg, stdout]);
  }

  async updateAll() {
    let dirs = fs.readdirSync("./plugins/");

    await this.runUpdate();

    for (let plu of dirs) {
      plu = this.getPlugin(plu);
      if (plu === false) continue;
      await common.sleep(1500);
      await this.runUpdate(plu);
    }

    if (this.isUp) {
      // await this.reply('即将执行重启，以应用更新')
      setTimeout(() => this.restart(), 2000);
    }
  }

  restart() {
    new Restart(this.e).restart();
  }

  async getLog(plugin = "") {
    let cm =
      'git log  -20 --oneline --pretty=format:"%h||[%cd]  %s" --date=format:"%m-%d %H:%M"';
    if (plugin) {
      cm = `cd ./plugins/${plugin}/ && ${cm}`;
    }

    let logAll;
    try {
      logAll = await execSync(cm, { encoding: "utf-8" });
    } catch (error) {
      logger.error(error.toString());
      this.reply(error.toString());
    }

    if (!logAll) return false;

    logAll = logAll.split("\n");

    let log = [];
    for (let str of logAll) {
      str = str.split("||");
      if (str[0] == this.oldCommitId) break;
      if (str[1].includes("Merge branch")) continue;
      log.push(str[1]);
    }
    let line = log.length;
    log = log.join("\n\n");

    if (log.length <= 0) return "";

    let end = "";
    if (!plugin) {
      end =
        "更多详细信息，请前往gitee查看\nhttps://gitee.com/huifeidemangguomao/MangoCat-Yunzai/edit/main/";
    }

    log = await this.makeForwardMsg(
      `${plugin || "MangoCat-Yunzai"}更新日志，共${line}条`,
      log,
      end,
    );

    return log;
  }

  async makeForwardMsg(title, msg, end) {
    let nickname = Bot.nickname;
    if (this.e.isGroup) {
      let info = await Bot.getGroupMemberInfo(this.e.group_id, Bot.uin);
      nickname = info.card ?? info.nickname;
    }
    let userInfo = {
      user_id: Bot.uin,
      nickname,
    };

    let forwardMsg = [
      {
        ...userInfo,
        message: title,
      },
      {
        ...userInfo,
        message: msg,
      },
    ];

    if (end) {
      forwardMsg.push({
        ...userInfo,
        message: end,
      });
    }

    /** 制作转发内容 */
    if (this.e.isGroup) {
      forwardMsg = await this.e.group.makeForwardMsg(forwardMsg);
    } else {
      forwardMsg = await this.e.friend.makeForwardMsg(forwardMsg);
    }

    /** 处理描述 */
    if (typeof forwardMsg.data === "string") {
      forwardMsg.data = forwardMsg.data
        .replace(/\n/g, "")
        .replace(/<title color="#777777" size="26">(.+?)<\/title>/g, "___")
        .replace(/___+/, `<title color="#777777" size="26">${title}</title>`);
    } else if (forwardMsg.data && typeof forwardMsg.data === "object") {
      forwardMsg.data.desc = title;
      forwardMsg.data.prompt = title;
      if (forwardMsg.data.meta?.detail?.summary) {
        forwardMsg.data.meta.detail.summary = title;
      }
    }

    return forwardMsg;
  }

  async updateLog() {
    let log = await this.getLog();
    await this.reply(log);
  }
}
