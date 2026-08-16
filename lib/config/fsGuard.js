import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import cfg from "./config.js";
import { getCaller, broadcast, notifyMaster } from "./guardCore.js";

/**
 * 数据保护层 - 动态拦截插件对 data/config 等核心目录的危险删除操作
 *
 * 原理：插件通过 import("node:fs") 拿到的 fs 与本体是同一模块实例，
 * 在插件加载前包装 fs 的删除方法，即可对插件（及本体）的删除行为统一把关。
 *
 * 分级处理：
 *  - 极度危险（删除 config/、data 根、data/db/ 等核心路径）：阻止删除，
 *    全群广播告警 + 私信主人，提示检查插件
 *  - 一般危险（递归删除 data/ 下其他目录/文件）：删除前自动备份到备份目录，
 *    私信主人告知备份位置，可恢复
 *  - 正常（插件自身更新、temp/resources/logs 等）：放行，不打扰
 *
 * 可通过 config/config/other.yaml 的 dataGuard 开关关闭，dataBackupPath 配置备份目录
 */

/** 本体核心文件/目录：删除这些 = 极度危险（阻止），含其下所有内容 */
const CORE_FILES = [
  "app.js",
  "fmc.js",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".eslintrc.cjs",
  ".npmrc",
  ".puppeteerrc.cjs",
  "Dockerfile",
  "docker-compose.yaml",
  "docker-entrypoint.sh",
  "lib",
  "renderers",
  "docker",
  "resources",
  "plugins/adapter",
];

let installed = false;

/** 将目标路径转为相对项目根目录的路径 */
function toRel(target) {
  try {
    return path.relative(process.cwd(), path.resolve(target)).replace(/\\/g, "/");
  } catch (err) {
    return null;
  }
}

/** 判断是否核心保护路径（项目根、逃逸路径、config、data 根、data/db、本体核心文件） */
function isCore(rel) {
  // 项目根目录本身（rm -rf .，path.relative(cwd, cwd) 返回空字符串）
  if (rel === "" || rel === ".") return true;
  if (!rel) return false;
  // 逃逸到项目外（rm -rf /、../、跨盘符绝对路径）
  if (rel.startsWith("..") || path.isAbsolute(rel)) return true;
  // config 整目录、data 根、data/db 数据库目录
  if (rel === "config" || rel.startsWith("config/") || rel === "data" || rel === "data/db" || rel.startsWith("data/db/")) {
    return true;
  }
  // 本体核心文件/目录
  for (const f of CORE_FILES) {
    if (rel === f || rel.startsWith(f + "/")) return true;
  }
  return false;
}

/**
 * 判断是否 puppeteer 临时浏览器 profile 目录
 * puppeteer 未指定 userDataDir 时,会在系统临时目录创建 `puppeteer_dev_<browser>_profile-*` 并随浏览器退出清理,
 * 属正常行为,放行避免误拦;仅当同时满足「位于系统临时目录」+「固定命名」两个条件才放行,其余逃逸路径照旧拦截
 */
function isPuppeteerTempProfile(target) {
  try {
    const abs = path.resolve(target);
    const tmp = path.resolve(os.tmpdir());
    if (abs !== tmp && !abs.startsWith(tmp + path.sep)) return false;
    const name = path.basename(abs);
    return /^puppeteer_dev_[a-z]+_profile-/.test(name);
  } catch (err) {
    return false;
  }
}

/** 判断删除行为级别 */
function judge(target) {
  const rel = toRel(target);
  // 解析失败（如非法路径）不拦截
  if (rel === null) return { action: "pass" };
  // 放行 puppeteer 临时浏览器 profile（系统临时目录 + 固定命名，浏览器退出正常清理）
  if (isPuppeteerTempProfile(target)) return { action: "pass", rel };
  // 极度危险：项目根/逃逸/config/data根/data/db/本体核心文件，直接阻止
  if (isCore(rel)) return { action: "block", rel };
  // 一般危险：删除 data/ 下其他内容，删除前自动备份并私信主人
  if (rel.startsWith("data/")) return { action: "backup", rel };
  // 其余放行（plugins/ 除 adapter 外、temp/、logs/、node_modules/ 等正常更新/缓存清理）
  return { action: "pass", rel };
}

/** 计算备份目标路径 */
function backupDest(rel) {
  const dir = cfg.getOther().dataBackupPath || ".backup";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, stamp, rel);
}

/** 删除前同步备份目标到备份目录，返回备份路径或 null */
function backupTarget(target, rel) {
  try {
    const dest = backupDest(rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) fs.cpSync(target, dest, { recursive: true });
    else fs.copyFileSync(target, dest);
    return dest;
  } catch (err) {
    try {
      global.logger?.error(`[数据保护]备份失败：${rel}`, err);
    } catch (e) {}
    return null;
  }
}

/** 极度危险：阻止 + 全群广播 + 私信主人（点名插件） */
function blockHandle(rel, target, method, caller = "未知来源") {
  // 逃逸到项目外（rm -rf /、../、跨盘符）单独明确提示
  const escape = rel.startsWith("..") || path.isAbsolute(rel);
  const what = escape ? `项目目录之外的路径【${rel}】` : `核心数据目录/文件【${rel}】`;
  const text = `🚨 安全警告：插件【${caller}】正在试图删除${what}，已阻止！\n该行为极度危险，疑似恶意插件，请立即检查并卸载。`;
  try {
    global.logger?.mark(`[数据保护]已阻止危险删除[${method}]：${rel}（来源：${caller}）`);
  } catch (err) {}
  broadcast(text);
  notifyMaster(`🚨 检测到插件【${caller}】试图删除${what}（fs.${method}）\n已阻止该操作，未发生删除。\n如属插件更新行为请联系插件作者确认；请立即检查 plugins/ 目录下最近安装或更新的插件。`);
}

/** 一般危险：备份 + 私信主人（删除放行，点名插件） */
function backupHandle(rel, target, method, dest, caller = "未知来源") {
  const text = `⚠️ 检测到插件【${caller}】删除数据目录/文件：【${rel}】\n删除前已自动备份至：${dest}\n如属误删，可从备份目录恢复。`;
  try {
    global.logger?.mark(`[数据保护]删除前已备份[${method}]：${rel} -> ${dest}（来源：${caller}）`);
  } catch (err) {}
  notifyMaster(text);
}

/** 包装同步删除方法 */
function wrapSync(name) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = function (target, ...rest) {
    const { action, rel } = judge(target);
    const caller = getCaller();
    if (action === "block") {
      blockHandle(rel, target, name, caller);
      return false; // 阻止删除
    }
    if (action === "backup") {
      const dest = backupTarget(target, rel);
      backupHandle(rel, target, name, dest, caller);
      return orig.call(this, target, ...rest);
    }
    return orig.call(this, target, ...rest);
  };
}

/** 包装异步回调版删除方法（fs.rm/fs.rmdir/fs.unlink） */
function wrapAsync(name) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = function (target, ...rest) {
    const hasOpts = rest[0] && typeof rest[0] === "object";
    const cbIdx = hasOpts ? 1 : 0;
    const cb = rest[cbIdx];
    const { action, rel } = judge(target);
    const caller = getCaller();
    if (action === "block") {
      blockHandle(rel, target, name, caller);
      if (typeof cb === "function") cb(new Error(`[数据保护]已阻止危险删除：${rel}`));
      return;
    }
    if (action === "backup") {
      const dest = backupTarget(target, rel);
      backupHandle(rel, target, name, dest, caller);
      return orig.call(this, target, ...rest);
    }
    return orig.call(this, target, ...rest);
  };
}

/** 包装 fs.promises 异步删除方法 */
function wrapPromise(name) {
  const orig = fs.promises[name];
  if (typeof orig !== "function") return;
  fs.promises[name] = function (target, ...rest) {
    const { action, rel } = judge(target);
    const caller = getCaller();
    if (action === "block") {
      blockHandle(rel, target, `promises.${name}`, caller);
      return Promise.reject(new Error(`[数据保护]已阻止危险删除：${rel}`));
    }
    if (action === "backup") {
      const dest = backupTarget(target, rel);
      backupHandle(rel, target, name, dest, caller);
      return orig.call(this, target, ...rest);
    }
    return orig.call(this, target, ...rest);
  };
}

/** 关键配置文件：插件不得修改其中关键字段 */
const KEY_CONFIG_FILES = ["config/config/other.yaml"];
/** 关键字段：masterQQ（主人）、黑白名单——与插件无关，禁止非本体修改 */
const KEY_CONFIG_FIELDS = ["masterQQ", "whiteGroup", "blackGroup", "blackQQ"];

/**
 * 检测配置写入是否涉及关键字段被插件篡改
 * @returns {string|null} 被篡改的字段名（逗号分隔）或 null
 */
function checkConfigWrite(target, data) {
  const rel = toRel(target);
  if (!rel || !KEY_CONFIG_FILES.includes(rel)) return null;
  const caller = getCaller();
  // 本体（lib/ 等）写入放行，仅拦截插件写入
  if (!caller || !caller.startsWith("plugins/")) return null;
  try {
    const oldCfg = YAML.parse(fs.readFileSync(target, "utf8")) || {};
    const newCfg = YAML.parse(String(data)) || {};
    const changed = KEY_CONFIG_FIELDS.filter(
      (k) => JSON.stringify(oldCfg[k]) !== JSON.stringify(newCfg[k]),
    );
    return changed.length ? changed.join("/") : null;
  } catch (err) {
    return null;
  }
}

/** 阻止插件修改关键配置：全群广播 + 私信主人 */
function blockConfigWrite(target, method, changed, caller) {
  const text = `🚨 极度危险通报：插件【${caller}】试图修改关键配置【${target}】的字段【${changed}】（主人/黑白名单），已阻止！\n请立即检查并卸载该插件。`;
  try {
    global.logger?.mark(`[配置保护]已阻止插件修改关键配置[${method}]：${target} 字段 ${changed}（来源：${caller}）`);
  } catch (err) {}
  broadcast(text);
  notifyMaster(`🚨 检测到插件【${caller}】试图修改关键配置（${method}）：\n文件：${target}\n字段：${changed}\n已阻止，未生效。\n请立即检查 plugins/ 目录。\n\n如确认是误报，可将 config/config/other.yaml 中的 dataGuard 改为 false 后重启。`);
}

/** 包装同步写文件（writeFileSync） */
function wrapWriteSync(name) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = function (target, data, ...rest) {
    const changed = checkConfigWrite(target, data);
    if (changed) {
      blockConfigWrite(target, name, changed, getCaller());
      return false; // 阻止写入
    }
    return orig.call(this, target, data, ...rest);
  };
}

/** 包装异步回调写文件（writeFile） */
function wrapWriteAsync(name) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = function (target, data, ...rest) {
    const changed = checkConfigWrite(target, data);
    if (changed) {
      blockConfigWrite(target, name, changed, getCaller());
      const cb = rest[rest.length - 1];
      if (typeof cb === "function") cb(new Error(`[配置保护]已阻止插件修改关键配置：${changed}`));
      return;
    }
    return orig.call(this, target, data, ...rest);
  };
}

/** 包装 fs.promises 异步写文件 */
function wrapWritePromise(name) {
  const orig = fs.promises[name];
  if (typeof orig !== "function") return;
  fs.promises[name] = function (target, data, ...rest) {
    const changed = checkConfigWrite(target, data);
    if (changed) {
      blockConfigWrite(target, `promises.${name}`, changed, getCaller());
      return Promise.reject(new Error(`[配置保护]已阻止插件修改关键配置：${changed}`));
    }
    return orig.call(this, target, data, ...rest);
  };
}

/**
 * 安装数据保护层
 * 必须在插件加载前调用（本模块被 bot.js 顶部 import 时自动执行）
 */
export function install() {
  if (installed) return;
  installed = true;
  // 开关：other.yaml 的 dataGuard，默认开启
  if (cfg.getOther().dataGuard === false) return;
  try {
    // 同步删除
    wrapSync("rmSync");
    wrapSync("rmdirSync");
    wrapSync("unlinkSync");
    // 异步回调删除
    wrapAsync("rm");
    wrapAsync("rmdir");
    wrapAsync("unlink");
    // promises 异步删除
    wrapPromise("rm");
    wrapPromise("rmdir");
    wrapPromise("unlink");
    // 配置写保护：拦截插件修改关键配置字段（masterQQ/黑白名单）
    wrapWriteSync("writeFileSync");
    wrapWriteAsync("writeFile");
    wrapWritePromise("writeFile");
    global.logger?.info("数据保护层已启用：拦截插件删除 config/data 核心目录，保护关键配置字段");
  } catch (err) {
    try {
      global.logger?.error("[数据保护]安装失败", err);
    } catch (e) {}
  }
}

install();
