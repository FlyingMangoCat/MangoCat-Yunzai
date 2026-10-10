/**
 * 本体完整性自检 - 启动时比对本体代码目录与 git 仓库 HEAD
 *
 * 兜底防御：即便插件借 worker_threads（Node 24 上 ESM 具名导入的 Worker 拦不到）
 * 等旁路篡改了本体文件，改动会留在磁盘上，下次启动在此暴露。
 * 仅提醒不阻断：用户本人的合法本地改动（未提交）也会被列出，通报措辞保持中性。
 */
import { execFileSync } from "node:child_process";
import cfg from "./config.js";
import { notifyMaster } from "./guardCore.js";

/** 自检范围：本体代码（不含 config/ —— 用户可合法修改配置；不含 data/ —— 运行数据） */
const SCOPE = ["lib", "renderers", "app.js", "fmc.js"];

/**
 * 执行完整性自检
 * @returns {string[]} 与 HEAD 不一致的文件列表（空数组 = 一致）
 */
export function runIntegrityCheck() {
  try {
    if (cfg.getOther().dataGuard === false) return [];
    const out = execFileSync("git", ["status", "--porcelain", "--", ...SCOPE], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).toString();
    // 注意：不能整串 trim——会削掉首行的状态码前导空格（" M x" → "M x"），首行就解析不出路径了
    const files = out.split("\n").map(l => l.replace(/^..\s+/, "").trim()).filter(Boolean);
    if (!files.length) return [];
    global.logger?.warn(`[完整性自检]以下本体文件与仓库 HEAD 不一致（${files.length} 个）：${files.join(", ")}`);
    notifyMaster(`🔍 本体完整性自检：以下本体文件与仓库 HEAD 不一致（${files.length} 个）：\n${files.join("\n")}\n\n若非你本人修改，请排查 plugins/ 下最近安装或更新的插件（含其 worker 子线程）；确认无误后提交或还原即可消除提醒。`);
    return files;
  } catch (err) {
    // git 不可用等环境问题不阻断启动
    try {
      global.logger?.debug(`[完整性自检]执行失败(忽略)：${err?.message}`);
    } catch (e) {}
    return [];
  }
}

// 模块导入即执行：早于插件加载，通报经 guardCore 队列待 Bot 连接后补发
runIntegrityCheck();
