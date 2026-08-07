/**
 * 插件硬编码后门清洗 - 插件加载前的源码级处理
 *
 * 背景：TRSS-Plugin / yenai-plugin 类插件在源码/隐藏文件里硬编码了后门授权哈希
 * （隐藏管理员），对应 QQ 无需主人权限即可远程操控插件（远程命令/脚本执行/文件操作等），
 * 本质是静默驻留、触发即操控的远程操控木马病毒。
 *
 * 处理方式：检测到硬编码后门时，将后门载体替换/清除（其余代码不动），
 * 使 md5 授权比较恒为 false，后门失效、插件正常功能保留；
 * 同时解码出隐藏管理员 QQ 号列表，用于全群通报曝光。
 *
 * 仅处理硬编码后门，不拒载、不修改其他任何代码。
 * 可通过 config/config/other.yaml 的 pluginScan 开关关闭
 */

import v8 from "node:v8";
import fs from "node:fs";
import path from "node:path";

/** 已知后门哈希 → QQ 号映射（已破解确认，用于通报曝光隐藏管理员） */
const KNOWN_BACKDOOR_QQ = {
  f6c007a9a10421fbb91220da57269882: "746659424",
  b437fc003ae6bf776b581b2dde9945a3: "1509293009",
  ca7bcba1749aaaa4f2724df3b27c85ec: "2536554304",
  "8b5684734d8c98e067a1f0324c982ab1": "3139373986",
  "19dfffb8d70c4ad051a18e55d58c5e75": "2173302144",
};

/** data:text/javascript 内联 import 行（TRSS 后门载体），test 用不需 g 标志（避免 lastIndex 残留） */
const BACKDOOR_INLINE_IMPORT_RE = /^import\s+([_$\w]+)\s+from\s+['"]data:text\/javascript[^\n]*$/m;
/** 直接硬编码的 md5 授权比较：md5(user_id) == "32位hex"（哈希字面量后门） */
const BACKDOOR_MD5_LITERAL_RE = /md5\(\s*String\(\s*[^)\n]*user_id[^)\n]*\)\s*\)\s*(?:==|===)\s*["'][0-9a-fA-F]{32}["']/i;
/** yenai 变体：v8.deserialize 加载隐藏授权文件（外部文件 + 运行时反序列化） */
const BACKDOOR_DESERIALIZE_RE = /v8\.deserialize\s*\([^)]*readFile/i;
/** yenai 变体：includes(md5(...)) 授权列表比较 */
const BACKDOOR_MD5_INCLUDE_RE = /\.includes\(\s*md5\s*\(\s*String\s*\(/i;

/**
 * 格式级检测（不依赖载体，识别通用授权格式）：
 * 后门无论用 data:text / 隐藏文件 / JSON / 远程拉取哪个载体，最终代码都是同一形态：
 * 对 user_id 做哈希后与某值比较放行，或与硬编码 QQ 直接比较。换载体换算法都逃不掉这个格式。
 */
/** 格式A：任意函数调用(String(user_id)) 与 32-64位hex 字面量比较（==/===/!=/!==），不依赖哈希函数名（md5/sha256/封装改名均可识别） */
const AUTH_HASH_COMPARE_RE = /[_$\w]+\s*\(\s*String\s*\(\s*[^)\n]*user_id[^)\n]*\)\s*\)\s*(?:==|===|!=|!==)\s*["'][0-9a-fA-F]{32,64}["']/i;
/** 格式B：includes(哈希(user_id)) 授权列表比较 */
const AUTH_HASH_INCLUDE_RE = /\.includes\(\s*(?:md5|sha1|sha256|sha512)\s*\(\s*String\s*\(\s*[^)\n]*user_id[^)\n]*\)\s*\)/i;
/** 格式C：user_id 与硬编码 QQ 直接比较（明文授权） */
const AUTH_ID_COMPARE_RE = /(?:user_id|userId)\s*(?:==|===|!=|!==)\s*(?:["']\d{5,}["']|\d{5,})/;
/** 授权语境词：与 isMaster/master/includes/permission 同现才判定为授权后门（降低误报） */
const AUTH_CONTEXT_RE = /isMaster|master|includes\(|permission|privilege|admin/i;

/**
 * 检测源码是否存在硬编码后门
 * 认定顺序（由精确到通用）：
 *  1. data:text/javascript 内联代码导入（TRSS 载体）
 *  2. md5(user_id) 与硬编码哈希字面量比较
 *  3. v8.deserialize 隐藏授权文件 + includes(md5(user_id))（yenai 载体）
 *  4. 格式级：哈希(user_id) 授权比较 / includes(哈希) / user_id 与硬编码比较（不限载体）
 * @param {string} source 插件源码
 * @returns {string|null} 命中原因或 null
 */
export function detectBackdoor(source) {
  if (typeof source !== "string" || !source) return null;
  if (BACKDOOR_INLINE_IMPORT_RE.test(source)) return "硬编码内联代码(data:text/javascript)";
  if (BACKDOOR_MD5_LITERAL_RE.test(source)) return "硬编码后门哈希(md5(user_id) 与硬编码哈希比较)";
  if (BACKDOOR_DESERIALIZE_RE.test(source) && BACKDOOR_MD5_INCLUDE_RE.test(source)) {
    return "隐藏授权文件(v8.deserialize + includes(md5) 授权比较)";
  }
  // 格式级：通用授权比较格式（不限载体/算法），需与授权语境词同现降误报
  if (
    (AUTH_HASH_COMPARE_RE.test(source) || AUTH_HASH_INCLUDE_RE.test(source) || AUTH_ID_COMPARE_RE.test(source)) &&
    AUTH_CONTEXT_RE.test(source)
  ) {
    return "隐藏管理员授权比较(格式级：哈希/QQ 与值比较放行)";
  }
  return null;
}

/** yenai 变体：v8.deserialize 授权加载赋值行（`a = v8.deserialize(readFile(...)).map(...)`），
 *  位置无关清洗：无论隐藏文件在哪个路径，整行替换为 `a = []` 即可让授权列表失效 */
const BACKDOOR_DESERIALIZE_ASSIGN_RE = /^[\t ]*([_$\w]+)\s*=\s*v8\.deserialize\([^\n]*readFile[^\n]*\);?/m;

/** 格式级清洗：任意函数调用(String(user_id)) 与 32-64位hex 字面量比较 → false（不依赖哈希函数名，md5/sha256/封装改名均可） */
const AUTH_HASH_COMPARE_SANITIZE_RE = /[_$\w]+\s*\(\s*String\s*\(\s*[^)\n]*user_id[^)\n]*\)\s*\)\s*(?:==|===|!=|!==)\s*["'][0-9a-fA-F]{32,64}["']/gi;
/** 格式级清洗：includes(哈希(user_id)) 授权列表比较 → false */
const AUTH_HASH_INCLUDE_SANITIZE_RE = /\.includes\(\s*(?:md5|sha1|sha256|sha512)\s*\(\s*String\s*\(\s*[^)\n]*user_id[^)\n]*\)\s*\)\s*\)/gi;
/** 格式级清洗：user_id 与硬编码 QQ 直接比较 → false */
const AUTH_ID_COMPARE_SANITIZE_RE = /(?:user_id|userId)\s*(?:==|===|!=|!==)\s*(?:["']\d{5,}["']|\d{5,})/gi;

/**
 * 清洗源码：
 *  - TRSS 载体：data:text/javascript 内联 import 行 → 无害 const 声明
 *  - yenai 载体：v8.deserialize 授权加载赋值行 → `a = []`
 *  - 格式级：哈希(user_id) 授权比较 / includes(哈希) / user_id 硬编码比较 → false（不限载体，换载体也清洗）
 * @param {string} source 插件源码
 * @returns {{ changed: boolean, source: string }} 是否修改与清洗后源码
 */
export function sanitizeSource(source) {
  const out = String(source || "");
  let changed = false;
  let cleaned = out.replace(BACKDOOR_INLINE_IMPORT_RE, (m, name) => {
    changed = true;
    return `const ${name} = "backdoor-removed";`;
  });
  cleaned = cleaned.replace(BACKDOOR_DESERIALIZE_ASSIGN_RE, (m, name) => {
    changed = true;
    return `${name} = [];`;
  });
  // 格式级清洗：授权比较整体替换为 false，isMaster 退化为只认配置文件主人
  for (const re of [AUTH_HASH_COMPARE_SANITIZE_RE, AUTH_HASH_INCLUDE_SANITIZE_RE, AUTH_ID_COMPARE_SANITIZE_RE]) {
    cleaned = cleaned.replace(re, (m) => {
      changed = true;
      return "false";
    });
  }
  return { changed, source: cleaned };
}

/**
 * 从 TRSS 变体源码中提取硬编码哈希（data:text/javascript 内联 base64 → hex）
 * @param {string} source 插件源码
 * @returns {string[]} 十六进制哈希列表
 */
function extractInlineHashes(source) {
  const hashes = [];
  const re = /data:text\/javascript[^\n]*?Buffer\.from\(\s*["']([^"']+)["']\s*,\s*["']base64["']\s*\)[^\n]*?toString\(\s*["']hex["']\s*\)/gi;
  let m;
  while ((m = re.exec(source))) {
    try {
      hashes.push(Buffer.from(m[1], "base64").toString("hex"));
    } catch (err) {}
  }
  return hashes;
}

/**
 * 从 yenai 变体隐藏授权文件中提取哈希列表（v8 序列化数组 → hex）
 * 定位插件根目录下 .github/ISSUE_TEMPLATE/ 中的隐藏文件（非 .yml/.yaml）
 * @param {string} root 插件根目录
 * @returns {string[]} 十六进制哈希列表
 */
function extractHiddenHashes(root) {
  const hashes = [];
  try {
    const dir = `${root}/.github/ISSUE_TEMPLATE`;
    if (!fs.existsSync(dir)) return hashes;
    for (const i of fs.readdirSync(dir)) {
      if (i.endsWith(".yml") || i.endsWith(".yaml")) continue;
      const fp = path.join(dir, i);
      try {
        const arr = v8.deserialize(fs.readFileSync(fp));
        if (Array.isArray(arr)) {
          for (const b of arr) hashes.push(Buffer.from(b).toString("hex"));
        }
      } catch (err) {}
    }
  } catch (err) {}
  return hashes;
}

/**
 * 解析插件源码/隐藏文件中的硬编码后门哈希，映射为隐藏管理员 QQ 号
 * @param {string} source 插件源码
 * @param {string} root 插件根目录（相对 cwd）
 * @returns {{ qqs: string[], hashes: string[] }} 已知 QQ 号与全部哈希
 */
export function resolveBackdoorQQ(source, root) {
  const hashes = [...new Set([...extractInlineHashes(source), ...extractHiddenHashes(root)])];
  const qqs = hashes
    .map((h) => KNOWN_BACKDOOR_QQ[h])
    .filter((qq) => qq);
  return { qqs, hashes };
}
