/**
 * 本体完整性自检 - 启动时比对本体代码目录与 git 仓库 HEAD
 *
 * 兜底防御：即便插件借 worker_threads（Node 24 上 ESM 具名导入的 Worker 拦不到）
 * 等旁路篡改了本体文件，改动会留在磁盘上，下次启动在此暴露。
 * 仅提醒不阻断：用户本人的合法本地改动（未提交）也会被列出，通报措辞保持中性。
 *
 * 免提醒确认：主人回复 #自检确认 后，把当前差异文件的 sha256 记入
 * config/config/integrity_ack.json —— 该目录的写入与删除对插件被 fsGuard 拦截，
 * 插件无法自行写入确认记录来静音自己的篡改；文件内容再变更（哈希变化）会重新告警。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import cfg from "./config.js";
import { notifyMaster } from "./guardCore.js";

/** 自检范围：本体代码（不含 config/ —— 用户可合法修改配置；不含 data/ —— 运行数据） */
const SCOPE = ["lib", "renderers", "app.js", "fmc.js"];
const ACK_FILE = path.resolve("config/config/integrity_ack.json");

function sha256Of(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    // 文件不存在（如记录删除态）也用固定值参与比对
    return "deleted";
  }
}

function loadAck() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACK_FILE, "utf8"));
    return parsed && typeof parsed.files === "object" && parsed.files ? parsed : { files: {} };
  } catch {
    // 无记录/记录损坏时按空处理：全部照常告警（fail-safe）
    return { files: {} };
  }
}

function saveAck(ack) {
  fs.mkdirSync(path.dirname(ACK_FILE), { recursive: true });
  fs.writeFileSync(ACK_FILE, JSON.stringify(ack, null, 2));
}

/** 未跟踪的备份/临时文件不参与本体完整性告警（如手动 pull 前复制的 .bak） */
const IGNORE_UNTRACKED_RE = /(?:\.(?:bak|old|orig|tmp|temp|swp|swo|log|disabled)|~|(?:^|[\\/])\.DS_Store|(?:^|[\\/])Thumbs\.db)$/i;

/** git status 解析出与 HEAD 不一致的本体文件（相对路径） */
function listDiffs() {
  const out = execFileSync("git", ["status", "--porcelain", "--", ...SCOPE], {
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  }).toString();
  // 注意：不能整串 trim——会削掉首行的状态码前导空格（" M x" → "M x"），首行就解析不出路径了
  const files = [];
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // 只忽略未跟踪的备份/临时文件；已跟踪文件即使叫 .bak 也照常比对
    if (line.slice(0, 2) === "??" && IGNORE_UNTRACKED_RE.test(line.replace(/^..\s+/, "").trim())) continue;
    const file = line.replace(/^..\s+/, "").trim();
    if (file) files.push(file);
  }
  return files;
}

/** 过滤已被主人确认且内容未再变化的文件；确认记录缺失/文件又变了都会保留告警 */
export function filterAcked(files, ack) {
  const known = ack?.files || {};
  return files.filter((f) => known[f] !== sha256Of(f));
}

/**
 * 执行完整性自检
 * @returns {string[]} 与 HEAD 不一致且未被确认的文件列表（空数组 = 一致或已确认）
 */
export function runIntegrityCheck() {
  try {
    if (cfg.getOther().dataGuard === false) return [];
    const files = listDiffs();
    if (!files.length) return [];
    const flagged = filterAcked(files, loadAck());
    if (!flagged.length) return [];
    global.logger?.warn(`[完整性自检]以下本体文件与仓库 HEAD 不一致（${flagged.length} 个）：${flagged.join(", ")}`);
    notifyMaster(
      `🔍 本体完整性自检：以下本体文件与仓库 HEAD 不一致（${flagged.length} 个）：\n${flagged.join("\n")}\n\n` +
      `若非你本人修改，请排查 plugins/ 下最近安装或更新的插件（含其 worker 子线程）。\n` +
      `确认是自己的修改？回复 #自检确认 把当前内容记为已确认，后续启动不再提醒；文件再次变更会重新提醒。`,
    );
    return flagged;
  } catch (err) {
    // git 不可用等环境问题不阻断启动
    try {
      global.logger?.debug(`[完整性自检]执行失败(忽略)：${err?.message}`);
    } catch (e) {}
    return [];
  }
}

/** 主人 #自检确认：把当前全部差异按文件哈希记入确认台账 */
export function ackIntegrityChanges() {
  const files = listDiffs();
  if (!files.length) return [];
  const ack = loadAck();
  for (const f of files) ack.files[f] = sha256Of(f);
  saveAck(ack);
  return files;
}

// 模块导入即执行：早于插件加载，通报经 guardCore 队列待 Bot 连接后补发
runIntegrityCheck();
