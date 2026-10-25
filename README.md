# MangoCat-Yunzai v3 [Gitee](https://gitee.com/huifeidemangguomao/MangoCat-Yunzai.git)

基于[Yunzai-Bot](https://gitee.com/le-niao/Yunzai-Bot)&[Miao-Yunzai v3.0](https://gitee.com/yoimiya-kokomi/Miao-Yunzai)改造

需要同时安装[liulian-plugin](https://github.com/FlyingMangoCat/liulian-plugin.git)

项目仅供学习交流使用，严禁用于任何商业用途和非法行为

## 使用方法（[一键安装脚本](https://gitee.com/huifeidemangguomao/yunzai-one-button)）

> 环境准备： Windows or Linux，Node.js（ [版本至少v20.6以上](https://nodejs.cn/en/download) ）， [Redis](https://redis.io/docs/getting-started/installation/ )

1.克隆项目并安装liulian-plugin

请根据网络情况选择Github安装或Gitee安装

* 使用 Github 
```
git clone https://github.com/FlyingMangoCat/MangoCat-Yunzai.git
cd MangoCat-Yunzai
git clone https://github.com/FlyingMangoCat/liulian-plugin.git ./plugins/liulian-plugin/
```
* 使用Gitee
```
git clone https://gitee.com/huifeidemangguomao/MangoCat-Yunzai.git
cd MangoCat-Yunzai
git clone https://gitee.com/huifeidemangguomao/liulian-plugin.git ./plugins/liulian-plugin/
```

2.安装[pnpm](https://pnpm.io/zh/installation) ，已安装的可以跳过

* 使用npmjs.org安装
```
npm install pnpm -g
```

* 指定国内源npmmirror.com安装
```
npm --registry=https://registry.npmmirror.com install pnpm -g
```

3.安装依赖

* 直接安装
```
pnpm install -P
```
* 如依赖安装缓慢或失败，可尝试更换国内npm源后再执行install命令
```
pnpm config set registry https://registry.npmmirror.com
pnpm install -P
```

4.运行（首次运行按提示输入登录）

```
node app
```

## 协议端接入

除内置 icqq 外，支持通过 OneBotv11 适配器接入 NapCat、LLOneBot、Lagrange 等协议端：

1. 在协议端配置反向 WebSocket（reverse WS），地址填 `ws://127.0.0.1:25527/OneBotv11`（端口为本体 HTTP 服务端口，见 `config/server.yaml`）
2. 若在 `config/server.yaml` 的 `auth` 中配置了鉴权，需在协议端填入对应的 access token
3. 重启本体的同时启动协议端，看到连接成功日志即可

## Web 管理面板

本体自带管理面板，默认开启，浏览器访问 `http://127.0.0.1:25527/panel/`（本体的 HTTP 服务端口）。

- 首次访问按页面提示设置面板密码
- 支持插件管理（可选一键安装收录插件）、配置修改、资源监控、运行日志查看等
- 敏感操作（安装/卸载插件、修改主人 QQ 与黑白名单等）会向主人 QQ 私聊发确认请求
  - 面板总开关等配置见 `config/default_config/panel.yaml`

## 常见问题

### 从其他版本迁移到 MangoCat-Yunzai

`fmc.js` 是迁移脚本，放在**其他 Yunzai 版本（如 Miao-Yunzai、TRSS-Yunzai 等）的根目录**下执行，会自动把该目录切换为 MangoCat-Yunzai。

使用方法：

```bash
# 1. 从本仓库复制 fmc.js 到要迁移的 Yunzai 目录下
cp MangoCat-Yunzai/fmc.js /path/to/other-yunzai/

# 2. 进入该目录执行
cd /path/to/other-yunzai
node fmc
```

执行流程：
1. 备份当前配置（`bot.yaml`、`qq.yaml`、`other.yaml`、`server.yaml`）
2. 添加 FMC 远程仓库并拉取代码
3. 清理旧文件，切换到 FMC master 分支
4. 恢复之前备份的配置
5. 安装依赖
6. 清理临时备份

迁移完成后配置不变，直接重启 Bot 即可使用。

### puppeteer 相关问题

linux环境，其他环境请自行探索

```sh
    puppeteer Chromium 启动中...
    Error: Failed to launch the browser process!
```
1. 先检查node版本是否大于20.6 (不满足请去升级版本)
```sh
    node -v
```
2. 如果大于20.6 则可能是缺失一些库 请安装这些 (点击代码块右上角直接复制,如果报错可以尝试 sudo)

### 依赖库
```sh
    yum install pango.x86_64 libXcomposite.x86_64 libXcursor.x86_64 libXdamage.x86_64 libXext.x86_64 libXi.x86_64 libXtst.x86_64 cups-libs.x86_64 libXScrnSaver.x86_64 libXrandr.x86_64 GConf2.x86_64 alsa-lib.x86_64 atk.x86_64 gtk3.x86_64 -y
```

## 致谢

|                           Nickname                            | Contribution      |
|:-------------------------------------------------------------:|-------------------|
|      [Yunzai v3.0](https://gitee.com/le-niao/Yunzai-Bot)      | 乐神的Yunzai-Bot V3  |
|      [Miao-Yunzai v3.0](https://gitee.com/yoimiya-kokomi/Miao-Yunzai)      | 喵喵的Yunzai-Bot V3  |
| [GardenHamster](https://github.com/GardenHamster/GenshinPray) | 模拟抽卡背景素材来源        |
|      [西风驿站](https://bbs.mihoyo.com/ys/collection/839181)      | 角色攻略图来源           |
|     [米游社友人A](https://bbs.mihoyo.com/ys/collection/428421)     | 角色突破素材图来源         |
