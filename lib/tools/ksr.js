#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { exec } from "child_process";

// KSR (Kill and Start Redis) 功能
// 用于重启Redis服务

function ksr() {
  console.log("正在重启Redis服务...");

  // Windows环境下重启Redis的命令
  // 这里假设Redis已经作为服务安装
  exec("net stop redis && net start redis", (error, stdout, stderr) => {
    if (error) {
      console.log("Redis服务重启失败:", error.message);
      return;
    }
    if (stderr) {
      console.log("stderr:", stderr);
      return;
    }
    console.log("Redis服务重启成功:", stdout);
  });
}

// 如果直接运行此脚本，则执行ksr函数
if (import.meta.url === `file://${process.argv[1]}`) {
  ksr();
}

export default ksr;
