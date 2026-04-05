#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 获取logs目录路径
const logsDir = path.join(__dirname, "../../logs");

// 如果logs目录不存在，则创建
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// 读取最新的日志文件
const logFiles = fs
  .readdirSync(logsDir)
  .filter((file) => file.startsWith("log"))
  .sort();

if (logFiles.length === 0) {
  console.log("暂无日志文件");
  process.exit(0);
}

const latestLogFile = logFiles[logFiles.length - 1];
const logPath = path.join(logsDir, latestLogFile);

// 读取并显示日志内容
const logContent = fs.readFileSync(logPath, "utf8");
console.log(logContent);
