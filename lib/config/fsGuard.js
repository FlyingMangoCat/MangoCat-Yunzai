import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import cfg from "./config.js";
import { getCaller, isVerifiedSelf } from "./guardCore.js";
import { handleFinding } from "../security/findingLog.js";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";

/**
 * 数据保护层 - 动态拦截插件对 data/config 等核心目录的危险删除操作
 *
 * 原理：插件通过 import("node:fs") 拿到的 fs 与本体是同一模块实例，
 * 在插件加载前包装 fs 的删除方法，即可对插件（及本体）的删除行为统一把关。
 *
 * 分级处理：
 *  - 极度危险（删除 config/、data 根、data/db/ 等核心路径）：阻止删除，
 *    逐条记录 + 私信主人，提示检查插件
 *  - 一般危险（递归删除 data/ 下其他目录/文件）：删除前自动备份到备份目录，
 *    逐条记录并私信主人告知备份位置，可恢复
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
  // config 整目录、data 根、data/db 数据库目录、.git（删 git 数据可破坏哈希校验依据）
  if (rel === "config" || rel.startsWith("config/") || rel === "data" || rel === "data/db" || rel.startsWith("data/db/") ||
      rel === ".git" || rel.startsWith(".git/") ||
      rel === "data/security" || rel.startsWith("data/security/") ||
      rel === "data/panel" || rel.startsWith("data/panel/")) {
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

/**
 * 行为检测：记录最近由本进程写入过的文件（path -> 写入时间戳），
 * 删除时若命中"写入后短时间内删除"则视为自产临时文件清理（如导出后删临时文件），静默放行。
 * 不依赖调用者身份——攻击者篡改插件后直接删未写入过的数据文件，仍走备份+提示。
 * 写入缓存上限 500 条，超出后按时间淘汰最旧的，避免无限增长。
 */
const recentWrites = new Map();
const WRITE_CACHE_LIMIT = 500;
/** 写入后多少毫秒内删除视为自产临时文件（默认 10 分钟） */
const SELF_TMP_WINDOW = 10 * 60 * 1000;

function recordWrite(target) {
  try {
    const rel = toRel(target);
    if (!rel) return;
    recentWrites.set(rel, Date.now());
    if (recentWrites.size > WRITE_CACHE_LIMIT) {
      const oldest = [...recentWrites.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) recentWrites.delete(oldest[0]);
    }
  } catch (err) {}
}

/** 未被包装的 existsSync 快照：用于判定"写入前目标是否已存在" */
const rawExistsSync = fs.existsSync;

/**
 * 只在"写入前目标文件不存在"时才登记为本进程自产文件。
 * 已存在的文件不是本进程自产的：登记它等于给"先 rename/覆写已有数据、再删除"开绕过通报的后门。
 * 判定异常时不登记（等价于不放宽），保证安全强度不降。
 */
function recordCreatedWrite(target) {
  try {
    if (!target) return;
    if (rawExistsSync(target)) return;
    recordWrite(target);
  } catch (err) {
    /* 判定失败 → 不登记，维持原有备份通报 */
  }
}

/** 判断删除目标是否为"本进程刚写入的自产临时文件"（行为检测，不信任调用者） */
function isSelfTmpFile(target) {
  try {
    const rel = toRel(target);
    if (!rel) return false;
    const wroteAt = recentWrites.get(rel);
    if (!wroteAt) return false;
    // 写入后超过窗口期再删，不再视为临时文件清理
    if (Date.now() - wroteAt > SELF_TMP_WINDOW) {
      recentWrites.delete(rel);
      return false;
    }
    recentWrites.delete(rel);
    return true;
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
  // 放行渲染端 puppeteer 浏览器 profile（renderers/puppeteer 配置的 userDataDir，启动自愈/浏览器退出时正常清理）
  if (rel === "data/puppeteer" || rel.startsWith("data/puppeteer/")) return { action: "pass", rel };
  // 极度危险：项目根/逃逸/config/data根/data/db/本体核心文件，直接阻止
  // 必须先于行为检测，防止攻击者"先写入核心文件再删除"绕过 block
  if (isCore(rel)) return { action: "block", rel };
  // 行为检测：本进程刚写入的自产临时文件（先写后删，非核心路径），静默放行
  if (isSelfTmpFile(target)) return { action: "pass", rel };
  // 一般危险：删除 data/ 下其他内容，删除前自动备份并逐条记录
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

/** 极度危险：阻止 + 逐条记录 + 私信主人（点名插件） */
function blockHandle(rel, target, method, caller = "未知来源") {
  // 逃逸到项目外（rm -rf /、../、跨盘符）单独明确提示
  const escape = rel.startsWith("..") || path.isAbsolute(rel);
  const what = escape ? `项目目录之外的路径【${rel}】` : `核心数据目录/文件【${rel}】`;
  try {
    global.logger?.mark(`[数据保护]已阻止危险删除[${method}]：${rel}（来源：${caller}）`);
  } catch (err) {}
  // 本体可信调用（文件哈希与仓库一致）：属本体自身逻辑，误报不通报；删除仍拦截
  if (isVerifiedSelf(caller)) {
    try {
      global.logger?.mark(`[数据保护]本体可信调用，判定误报，不通报[${method}]：${rel}（来源：${caller}）`);
    } catch (err) {}
    return;
  }
  handleFinding({
    plugin: caller,
    ruleId: "fs.delete-core",
    level: "block",
    category: "tamper",
    file: rel,
    summary: `阻止删除${what}`,
    operation: `插件通过 fs.${method} 删除${what}`,
    evidence: { mode: "plain", text: `fs.${method}(${rel})` },
  }, { repeat: true });
}

/** 一般危险：备份 + 逐条记录 + 私信主人（删除放行，点名插件） */
function backupHandle(rel, target, method, dest, caller = "未知来源") {
  try {
    global.logger?.mark(`[数据保护]删除前已备份[${method}]：${rel} -> ${dest}（来源：${caller}）`);
  } catch (err) {}
  handleFinding({
    plugin: caller,
    ruleId: "fs.delete-backup",
    level: "notify",
    category: "tamper",
    file: rel,
    summary: "删除数据前已自动备份",
    operation: `插件通过 fs.${method} 删除 ${rel}，备份至 ${dest}`,
    evidence: { mode: "plain", text: `fs.${method}(${rel}) -> ${dest}` },
  });
}

/**
 * backup 级删除的统一入口（同步/异步回调/promises 三路共用）。
 * 本体可信调用（文件哈希与仓库一致）判定误报：不备份、不通报，仅记日志后直接放行删除
 */
function backupAction(rel, target, method, caller) {
  if (isVerifiedSelf(caller)) {
    try {
      global.logger?.mark(`[数据保护]本体可信调用，判定误报，直接放行[${method}]：${rel}（来源：${caller}）`);
    } catch (err) {}
    return;
  }
  const dest = backupTarget(target, rel);
  backupHandle(rel, target, method, dest, caller);
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
      backupAction(rel, target, name, caller);
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
      backupAction(rel, target, name, caller);
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
      backupAction(rel, target, name, caller);
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

/** 阻止插件修改关键配置：逐条记录 + 私信主人 */
function blockConfigWrite(target, method, changed, caller) {
  try {
    global.logger?.mark(`[配置保护]已阻止插件修改关键配置[${method}]：${target} 字段 ${changed}（来源：${caller}）`);
  } catch (err) {}
  handleFinding({
    plugin: caller,
    ruleId: "fs.config-key-write",
    level: "block",
    category: "tamper",
    file: toRel(target) || String(target),
    summary: "阻止插件修改主人/黑白名单等关键配置",
    operation: `插件通过 ${method} 修改关键配置字段 ${changed}`,
    evidence: { mode: "plain", text: `${target} -> ${changed}` },
  }, { repeat: true });
}

/**
 * 插件写保护检测：拦截插件篡改本体代码目录与 .git（防绕开哈希豁免）。
 * - .git/**：任何调用方都拦（伪造 HEAD = 伪造"本体可信"豁免依据；本体的 git 操作走子进程，不经 node fs）
 * - 本体代码（lib/renderers/config/app.js 等）：仅拦插件调用方（本体自身写配置合法，git 更新走子进程）
 * @returns {string|null} 命中原因，未命中返回 null
 */
function isSecurityLogWriter() {
  try {
    return /lib[\/]security[\/]findingLog\.js/.test(String(new Error().stack || ""));
  } catch {
    return false;
  }
}

function checkProtectedWrite(target) {
  const rel = toRel(target);
  if (!rel) return null;
  if (rel === ".git" || rel.startsWith(".git/")) return ".git 目录";
  // 审计记录写入由 findingLog 完成；即使调用栈里还有触发事件的插件，也不能拦自己
  if ((rel === "data/security" || rel.startsWith("data/security/")) && isSecurityLogWriter()) return null;
  const caller = getCaller();
  if (!caller.startsWith("plugins/")) return null;
  if (rel === "data/security" || rel.startsWith("data/security/") ||
      rel === "data/panel" || rel.startsWith("data/panel/")) return "安全审计/面板数据";
  if (
    rel === "lib" || rel.startsWith("lib/") ||
    rel === "renderers" || rel.startsWith("renderers/") ||
    rel === "app.js" || rel === "fmc.js" ||
    rel === "package.json" || rel === "pnpm-workspace.yaml"
  ) return "本体核心文件";
  // config 下仅保护本体自有配置（用户配置/默认模板/pm2/test）；config/ 根的单文件 yaml/yml/json 是插件
  // 自配置的惯例位置，本体控制面只读取 config/config 与 default_config，不读这些文件，放行
  if (rel === "config" || rel.startsWith("config/")) {
    if (
      rel === "config/config" || rel.startsWith("config/config/") ||
      rel === "config/default_config" || rel.startsWith("config/default_config/") ||
      rel === "config/pm2" || rel.startsWith("config/pm2/") ||
      rel === "config/test" || rel.startsWith("config/test/")
    ) return "本体核心文件";
    if (/^config\/[^/]+\.(ya?ml|json)$/i.test(rel)) return null;
    return "本体核心文件";
  }
  return null;
}

/** 阻止插件篡改本体代码/.git：逐条记录 + 私信主人 */
function blockProtectedWrite(target, method, reason, caller) {
  try {
    global.logger?.mark(`[写保护]已阻止插件写入${reason}[${method}]：${target}（来源：${caller}）`);
  } catch (err) {}
  handleFinding({
    plugin: caller,
    ruleId: "fs.protected-write",
    level: "block",
    category: "tamper",
    file: toRel(target) || String(target),
    summary: `阻止插件写入${reason}`,
    operation: `插件通过 ${method} 写入 ${reason}`,
    evidence: { mode: "plain", text: `${method}(${target})` },
  }, { repeat: true });
}

/** 包装同步写文件（writeFileSync） */
function wrapWriteSync(name) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = function (target, data, ...rest) {
    const prot = checkProtectedWrite(target);
    if (prot) {
      blockProtectedWrite(target, name, prot, getCaller());
      return false; // 阻止写入
    }
    const changed = checkConfigWrite(target, data);
    if (changed) {
      blockConfigWrite(target, name, changed, getCaller());
      return false; // 阻止写入
    }
    recordCreatedWrite(target); // 行为检测：只登记本进程新建的文件，已存在的不登记
    return orig.call(this, target, data, ...rest);
  };
}

/** 包装异步回调写文件（writeFile） */
function wrapWriteAsync(name) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = function (target, data, ...rest) {
    const prot = checkProtectedWrite(target);
    if (prot) {
      blockProtectedWrite(target, name, prot, getCaller());
      const cb = rest[rest.length - 1];
      if (typeof cb === "function") cb(new Error(`[写保护]已阻止插件写入：${prot}`));
      return;
    }
    const changed = checkConfigWrite(target, data);
    if (changed) {
      blockConfigWrite(target, name, changed, getCaller());
      const cb = rest[rest.length - 1];
      if (typeof cb === "function") cb(new Error(`[配置保护]已阻止插件修改关键配置：${changed}`));
      return;
    }
    recordCreatedWrite(target); // 行为检测：只登记本进程新建的文件，已存在的不登记
    return orig.call(this, target, data, ...rest);
  };
}

/** 包装 fs.promises 异步写文件 */
function wrapWritePromise(name) {
  const orig = fs.promises[name];
  if (typeof orig !== "function") return;
  fs.promises[name] = function (target, data, ...rest) {
    const prot = checkProtectedWrite(target);
    if (prot) {
      blockProtectedWrite(target, `promises.${name}`, prot, getCaller());
      return Promise.reject(new Error(`[写保护]已阻止插件写入：${prot}`));
    }
    const changed = checkConfigWrite(target, data);
    if (changed) {
      blockConfigWrite(target, `promises.${name}`, changed, getCaller());
      return Promise.reject(new Error(`[配置保护]已阻止插件修改关键配置：${changed}`));
    }
    recordCreatedWrite(target); // 行为检测：只登记本进程新建的文件，已存在的不登记
    return orig.call(this, target, data, ...rest);
  };
}

function blockMutate(targets, method, caller) {
  for (const target of targets) {
    if (!target) continue;
    const prot = checkProtectedWrite(target);
    if (prot) {
      blockProtectedWrite(target, method, prot, caller);
      return true;
    }
  }
  return false;
}

function hasWriteFlag(flags) {
  if (typeof flags === "number") {
    const C = fs.constants;
    return (flags & (C.O_WRONLY | C.O_RDWR | C.O_CREAT | C.O_TRUNC | C.O_APPEND)) !== 0;
  }
  return /[wa+]/i.test(String(flags || ""));
}

function wrapMutateSync(name, indexes, recordIdx = []) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = function (...args) {
    const targets = indexes.map((i) => args[i]).filter(Boolean);
    if (blockMutate(targets, name, getCaller())) return false;
    // 只登记"本进程新建并写入内容的路径"，供删除时按自产临时文件豁免；不登记 chmod/chown/rename 源端
    for (const i of recordIdx) if (args[i]) recordCreatedWrite(args[i]);
    return orig.apply(this, args);
  };
}

function wrapMutateCallback(name, indexes, recordIdx = []) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = function (...args) {
    const targets = indexes.map((i) => args[i]).filter(Boolean);
    if (blockMutate(targets, name, getCaller())) {
      const cb = [...args].reverse().find((i) => typeof i === "function");
      if (cb) cb(new Error(`[写保护]已阻止插件写入：${targets.join(", ")}`));
      return;
    }
    for (const i of recordIdx) if (args[i]) recordCreatedWrite(args[i]);
    return orig.apply(this, args);
  };
}

function wrapMutatePromise(name, indexes, recordIdx = []) {
  const orig = fs.promises[name];
  if (typeof orig !== "function") return;
  fs.promises[name] = function (...args) {
    const targets = indexes.map((i) => args[i]).filter(Boolean);
    if (blockMutate(targets, name, getCaller())) {
      return Promise.reject(new Error(`[写保护]已阻止插件写入：${targets.join(", ")}`));
    }
    for (const i of recordIdx) if (args[i]) recordCreatedWrite(args[i]);
    return orig.apply(this, args);
  };
}

function wrapOpenSyncLike(name, promises = false) {
  const obj = promises ? fs.promises : fs;
  const orig = obj[name];
  if (typeof orig !== "function") return;
  obj[name] = function (target, flags, ...rest) {
    const writing = hasWriteFlag(flags);
    if (writing && blockMutate([target], name, getCaller())) {
      if (promises) return Promise.reject(new Error(`[写保护]已阻止插件写入：${target}`));
      if (name.endsWith("Sync")) return -1;
      const cb = [...rest].reverse().find((i) => typeof i === "function");
      if (cb) cb(new Error(`[写保护]已阻止插件写入：${target}`));
      return;
    }
    // 以写模式 open 会创建新文件（已存在的不登记）：登记后随后的删除才可被识别为自产临时文件
    if (writing && target) recordCreatedWrite(target);
    return orig.apply(this, [target, flags, ...rest]);
  };
}

function wrapCreateWriteStream() {
  const orig = fs.createWriteStream;
  if (typeof orig !== "function") return;
  fs.createWriteStream = function (target, ...rest) {
    if (blockMutate([target], "createWriteStream", getCaller())) {
      throw new Error(`[写保护]已阻止插件写入：${target}`);
    }
    // 流式写入（下载临时文件最常见）此前未登记，导致随后删除被判"篡改"；此处置记以走自产临时文件豁免
    if (target) recordCreatedWrite(target);
    return orig.call(this, target, ...rest);
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
    // worker_threads 守卫注入：Worker 内 fs 是独立模块实例，主线程的包装拦不到。
    // Node >= 20.6 才支持 --import 引导（workerBootstrap.js）：
    // 1) push 进 execArgv——老版本 Node 的 Worker 默认继承父 execArgv，自动生效
    //    （Node 24 起继承时过滤 --import，实测 worker 拿到空数组，此路失效）
    // 2) 包装 Worker 构造器显式注入——覆盖 default 导入 / createRequire 创建的 Worker。
    //    已知局限：ESM 具名导入（import { Worker } from 'node:worker_threads'）在进程启动时
    //    快照原生类，无法拦截（实测 Node 24），此类 Worker 在新版本 Node 上不受守卫
    const [maj, min] = process.versions.node.split(".").map(Number);
    const bootstrapHref = new URL("./workerBootstrap.js", import.meta.url).href;
    if (maj > 20 || (maj === 20 && min >= 6)) {
      if (!process.execArgv.includes(bootstrapHref)) {
        process.execArgv.push("--import", bootstrapHref);
      }
      const OrigWorker = workerThreads.Worker;
      if (OrigWorker && !OrigWorker.__guardPatched) {
        const GuardedWorker = function (filename, options = {}) {
          const inherited = Array.isArray(options?.execArgv) ? options.execArgv : process.execArgv;
          return new OrigWorker(filename, {
            ...options,
            execArgv: [...inherited.filter(a => a !== "--import" && a !== bootstrapHref), "--import", bootstrapHref],
          });
        };
        GuardedWorker.prototype = OrigWorker.prototype;
        Object.setPrototypeOf(GuardedWorker, OrigWorker);
        GuardedWorker.__guardPatched = true;
        workerThreads.Worker = GuardedWorker;
      }
    } else {
      try {
        global.logger?.warn(`[数据保护]Node < 20.6 无法为 worker_threads 注入守卫（当前 ${process.versions.node}），Worker 内删除不受拦截`);
      } catch (err) {}
    }
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
    // 其余常见写/改/复制/链接路径：原先只包 writeFile，append/copy/rename 等可直接绕过
    // 登记口径：只有"本进程新建并写入内容"的路径才登记（append 且文件原本不存在、open 写模式新建、
    // createWriteStream），且一律经 recordCreatedWrite 校验"写入前不存在"。
    // 不登记 chmod/chown（仅改元数据，否则"改权限再删"可绕过通报）、rename/copy 的目标端（内容非自产）。
    for (const name of ["appendFileSync"]) {
      wrapMutateSync(name, [0], [0]);
    }
    for (const name of ["truncateSync", "chmodSync", "chownSync"]) {
      wrapMutateSync(name, [0]);
    }
    // copy/rename/link/symlink 只是"搬运/复制既有内容"，目标端不是本进程自产，一律不登记：
    // 否则"把 data/xxx.db 改名再删"就能绕过备份通报（改前删除是会备份的）
    for (const name of ["copyFileSync", "renameSync", "symlinkSync", "linkSync", "cpSync"]) {
      wrapMutateSync(name, [0, 1]);
    }
    for (const name of ["appendFile"]) {
      wrapMutateCallback(name, [0], [0]);
    }
    for (const name of ["truncate", "chmod", "chown"]) {
      wrapMutateCallback(name, [0]);
    }
    for (const name of ["copyFile", "rename", "symlink", "link", "cp"]) {
      wrapMutateCallback(name, [0, 1]);
    }
    for (const name of ["appendFile"]) {
      wrapMutatePromise(name, [0], [0]);
    }
    for (const name of ["truncate", "chmod", "chown"]) {
      wrapMutatePromise(name, [0]);
    }
    for (const name of ["copyFile", "rename", "symlink", "link", "cp"]) {
      wrapMutatePromise(name, [0, 1]);
    }
    wrapOpenSyncLike("openSync");
    wrapOpenSyncLike("open");
    wrapOpenSyncLike("open", true);
    wrapCreateWriteStream();
    // 让 ESM 具名导入拿到包装后的 fs/fs.promises 函数，而不是内置模块的旧快照
    try {
      syncBuiltinESMExports();
    } catch (err) {
      global.logger?.warn?.("[数据保护] ESM 导出同步失败，具名导入可能绕过包装", err);
    }
    // 冻结被包装的删除方法：插件加载晚于守卫安装，拿不到原生引用，
    // 冻结后无法用 fs.rm = x / delete fs.rm 还原原生方法绕过拦截。
    // 只冻删除方法，不动读写方法——graceful-fs 类依赖会给 writeFile 等打补丁，冻了会炸依赖
    for (const [obj, names] of [
      [fs, ["rm", "rmSync", "rmdir", "rmdirSync", "unlink", "unlinkSync"]],
      [fs.promises, ["rm", "rmdir", "unlink"]],
    ]) {
      for (const n of names) {
        try {
          const cur = obj[n];
          if (typeof cur === "function") {
            Object.defineProperty(obj, n, { value: cur, writable: false, configurable: false });
          }
        } catch (err) {}
      }
    }
    global.logger?.info("数据保护层已启用：拦截插件删除 config/data 核心目录，保护关键配置字段");
  } catch (err) {
    try {
      global.logger?.error("[数据保护]安装失败", err);
    } catch (e) {}
  }
}

install();
