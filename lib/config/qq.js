import fs from "fs";
import cfg from "./config.js";
import common from "../common/common.js";
import chalk from "chalk";

/**
 * 写入 icqq 启用开关（enable/autoLogin），文件缺失时先从默认配置生成
 */
function setIcqqFlags(enable) {
  const path = "./config/config/icqq.yaml";
  if (!fs.existsSync(path))
    fs.writeFileSync(path, fs.readFileSync("./config/default_config/icqq.yaml", "utf8"), "utf8");
  const content = fs.readFileSync(path, "utf8");
  fs.writeFileSync(
    path,
    content
      .replace(/^enable:.*/m, `enable: ${enable}`)
      .replace(/^autoLogin:.*/m, `autoLogin: ${enable}`),
    "utf8",
  );
}

/**
 * 创建qq配置文件 `config/bot/qq.yaml`
 * Git Bash 运行npm命令会无法选择列表
 */
export default async function createQQ() {
  if (!process.argv.includes("login")) {
    if (cfg.qq) return
    // 未配置QQ号但非login模式，跳过（如通过WebSocket连接）
    return
  }
  console.log(
    `欢迎使用${chalk.green("MangoCat-Yunzai v" + cfg.package.version)}\n` +
    `请选择协议端接入方式（输入编号）：\n` +
    `  1 - icqq 内置登录：使用 QQ 号或扫码登录，继续配置 QQ 信息\n` +
    `  2 - WebSocket 外接：使用 NapCat、Lagrange 等协议端连接本框架，跳过 QQ 登录配置`,
  );

  let inquirer
  try {
    inquirer = (await import("inquirer")).default
  } catch {
    logger.error("inquirer 未安装，无法进行交互式配置，请先执行 pnpm install")
    return
  }

  const { adapter } = await inquirer.prompt([
    {
      type: "Input",
      message: "请输入编号：",
      name: "adapter",
      validate(value) {
        if (["1", "2"].includes(String(value).trim())) return true;
        return "请输入 1 或 2";
      },
    },
  ]);

  // WebSocket 外接协议端：不配置 QQ 登录，显式停用 icqq
  if (String(adapter).trim() === "2") {
    console.log("已选择 WebSocket 接入，跳过 QQ 登录配置");
    setIcqqFlags(false);
    const port = cfg.server?.port || 25527;
    console.log(
      `请将协议端的反向 WS 地址指向：\n` +
      `  ws://<本机IP>:${port}/OneBotv11\n` +
      `协议端连接成功后账号自动上线，无需在本体侧配置 QQ 号\n` +
      `后续如需改用 icqq，可运行命令：${chalk.green("npm run login")}`,
    );
    return;
  }

  console.log("已选择 icqq 内置登录，请继续完成 QQ 配置");
  let propmtList = [
    {
      type: "Input",
      message: "请输入机器人QQ号(请用小号)：",
      name: "QQ",
      validate(value) {
        if (/^[1-9][0-9]{4,14}$/.test(value)) return true;
        return "请输入正确的QQ号";
      },
    },
    {
      type: process.platform == "win32" ? "Input" : "password",
      message: "请输入登录密码(为空则扫码登录)：",
      name: "pwd",
    },
    {
      type: "list",
      message: "请选择登录端口：",
      name: "platform",
      default: "6",
      choices: ["old_Android", "iPad", "安卓手机", "安卓手表", "MacOS", "aPad"],
      filter: (val) => {
        switch (val) {
          case "old_Android":
            return 6;
          case "iPad":
            return 5;
          case "MacOS":
            return 4;
          case "安卓手机":
            return 1;
          case "安卓手表":
            return 3;
          case "aPad":
            return 2;
          default:
            return 6;
        }
      },
    },
    // ,{
    //   type: 'Input',
    //   message: '代理服务器地址,无需代理服务器请直接按下Enter：',
    //   name: 'proxyAddress',
    //   default: 'http://0.0.0.0:0'
    // }
  ];

  if (!process.argv.includes("login")) {
    propmtList.push({
      type: "Input",
      message: "请输入主人QQ号：",
      name: "masterQQ",
    });
  }
  const ret = await inquirer.prompt(propmtList);

  let file = "./config/config/";
  let fileDef = "./config/default_config/";

  let qq = fs.readFileSync(`${fileDef}qq.yaml`, "utf8");

  qq = qq.replace(/qq:/g, "qq: " + ret.QQ);
  qq = qq.replace(/pwd:/g, `pwd:  '${ret.pwd}'`);
  qq = qq.replace(/platform: [1-6]/g, "platform: " + Number(ret.platform));
  fs.writeFileSync(`${file}qq.yaml`, qq, "utf8");

  let bot = fs.readFileSync(`${fileDef}bot.yaml`, "utf8");
  // bot = bot.replace(/proxyAddress:/g, `proxyAddress:  ${ret.proxyAddress}`)

  if (ret.masterQQ) {
    let other = fs.readFileSync(`${fileDef}other.yaml`, "utf8");
    other = other.replace(/masterQQ:/g, `masterQQ:\n  - ${ret.masterQQ}`);
    fs.writeFileSync(`${file}other.yaml`, other, "utf8");
  }

  fs.writeFileSync(`${file}bot.yaml`, bot, "utf8");
  setIcqqFlags(true);

  console.log(
    `\nQQ配置完成，正在登录\n后续修改账号可以运行命令： ${chalk.green("npm run login")}\n`,
  );

  await common.sleep(2000);
}
