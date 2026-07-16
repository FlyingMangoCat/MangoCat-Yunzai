console.log("正迁移到 MangoCat-Yunzai")

import fs from "node:fs"
import { execSync } from "child_process"
import YAML from "yaml"

function exec(cmd) {
  try {
    console.log(`执行命令 [${cmd}]`)
    console.log(execSync(cmd).toString())
    return true
  } catch (err) {
    console.error("执行", cmd, "失败", err)
    return false
  }
}

function rm(file) {
  try {
    if (!fs.existsSync(file)) return true
    return process.platform == "win32"
      ? exec(`rd /s /q "${file.replace(/\//g, "\\")}"`)
      : exec(`rm -rf "${file}"`)
  } catch (err) {
    console.error("删除", file, "错误", err)
    return false
  }
}

function mv(file, target) {
  try {
    if (!fs.existsSync(file)) return false
    if (fs.existsSync(target)) rm(target)
    return fs.renameSync(file, target)
  } catch (err) {
    console.error("移动", file, target, "错误", err)
    return false
  }
}

function readYaml(file) {
  try {
    if (!fs.existsSync(file)) return {}
    return YAML.parse(fs.readFileSync(file, "utf-8"))
  } catch (err) {
    console.error("读取", file, "错误", err)
    return {}
  }
}

function writeYaml(file, data) {
  try {
    return fs.writeFileSync(file, YAML.stringify(data), "utf-8")
  } catch (err) {
    console.error("写入", file, "错误", err)
    return false
  }
}

// 备份当前配置
console.log("备份当前配置...")
const botCfg = readYaml("config/config/bot.yaml")
const qqCfg = readYaml("config/config/qq.yaml")
const otherCfg = readYaml("config/config/other.yaml")
const serverCfg = readYaml("config/config/server.yaml")

// 添加远程仓库并拉取
exec("git remote add fmc https://gitee.com/huifeidemangguomao/MangoCat-Yunzai")
exec("git fetch fmc master")
exec("git clean -df")
mv("config/config", "config/config_bak")
exec("git reset --hard")
exec("git checkout --track fmc/master")

// 恢复配置
console.log("恢复配置...")
if (Object.keys(botCfg).length) writeYaml("config/config/bot.yaml", botCfg)
if (Object.keys(qqCfg).length) writeYaml("config/config/qq.yaml", qqCfg)
if (Object.keys(otherCfg).length) writeYaml("config/config/other.yaml", otherCfg)
if (Object.keys(serverCfg).length) writeYaml("config/config/server.yaml", serverCfg)

// 安装依赖
exec("npm install --ignore-scripts")

// 清理备份
rm("config/config_bak")

console.log("迁移完成，请重启 Bot")