# MangoCat-Yunzai v3 [Gitee](https://gitee.com/huifeidemangguomao/MangoCat-Yunzai.git)

基于[Yunzai-Bot](https://gitee.com/le-niao/Yunzai-Bot) 改造

需要同时安装[liulian-plugin](https://github.com/FlyingMangoCat/liulian-plugin.git)


项目仅供学习交流使用，严禁用于任何商业用途和非法行为

## 使用方法

> 环境准备： Windows or Linux，Node.js（ [版本至少v16以上](http://nodejs.cn/download/) ）， [Redis](https://redis.io/docs/getting-started/installation/ )

1.克隆项目并安装liulian-plugin

请根据网络情况选择Github安装或Gitee安装

* 使用 Github 
```
git clone https://github.com/FlyingMangoCat/MangoCat-Yunzai.git
cd MangoCat-Yunzai
git clone https://github.com/FlyingMangoCat/liulian-plugin.git ./plugins/miao-plugin/
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


## 常见问题

### puppeteer 相关问题

linux环境，其他环境请自行探索

```sh
    puppeteer Chromium 启动中...
    Error: Failed to launch the browser process!
```
1. 先检查node版本是否大于14 (不大于14请去升级版本)
```sh
    node -v
```
2. 如果大于14 则可能是缺失一些库 请安装这些 (点击代码块右上角直接复制,如果报错可以尝试 sudo)

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
