# MangoCat-Yunzai 插件生态与兼容契约 v0.1

> 状态：草案（v0.1），未发布
> 维护：MangoCat-Yunzai 主线
> 适用：本运行时（icqq / OneBotv11 / 其他适配器）与所有第三方插件

---

## 1. 适用范围与原则

本文对内置插件和第三方插件同样有效，安全红线对本体也适用。

收录与排序按本文执行，判断标准公开，结果可以由同一条命令复算。不因为某个具体插件临时加规则，新规则也不追溯已经收录的插件。

规则由主线维护。任何人可以按第 7 节提修订，公示 7 天后无反对即生效。

---

## 2. 兼容基线（L1）

这一节列的是运行时已经对外提供、并被插件实际依赖的行为。不跟进第 3 节的新规定，插件照样能跑；但这些行为一旦改掉，插件就会坏。

### 2.1 事件对象 `e`

| 字段 | 说明 | 状态 |
|---|---|---|
| `e.msg` | 文本消息，多段拼接，中文 `#` 归一 | 稳定 |
| `e.img[]` | 图片 URL 数组 | 稳定 |
| `e.file{name,fid}` | 文件段，兼容 OneBotv11 字段 | 稳定 |
| `e.at` / `e.atBot` | 被 at 的 QQ / 是否 at 机器人 | 稳定 |
| `e.hasAlias` | 是否命中 botAlias 前缀 | 稳定 |
| `e.isPrivate` / `e.isGroup` / `e.isGuild` | 场景判定 | 稳定 |
| `e.user_id` / `e.group_id` | 身份 | 稳定 |
| `e.sender{card,nickname}` / `e.member` / `e.group` / `e.friend` | 上下文对象 | 稳定 |
| `e.game` / `e.isSr` / `e.isGs` | 游戏判定（gs / sr / zzz） | 稳定 |
| `e.isMaster` | 只读，由 `cfg.isMasterQQ()` 计算；插件赋值会被拦截并通报 | 稳定 |
| `e.runtime` | 运行时助手（render / mys / common / cfg / handler） | 稳定 |
| `e.user` | 用户数据 Proxy | 稳定 |
| `e.reply(msg, quote, data)` | 回复；`data.recallMsg` / `data.at` | 稳定 |
| `e.logText` / `e.logFnc` | 日志字段 | 稳定 |
| `e.adapter_id` / `e.adapter_name` | 来源适配器 | 稳定 |
| `e._skipPlugins` | 内部跳过名单，插件不要依赖 | 可演进 |

### 2.2 插件模型

| 项 | 说明 | 状态 |
|---|---|---|
| `constructor({name, dsc, event, priority, task, rule, handler, namespace})` | 默认 `priority = 9999` | 稳定 |
| `rule[] = {reg, fnc, event, log, permission}` | 正则命令 | 稳定 |
| `handler[] = {key, fn, priority}` | 事件总线注册 | 稳定 |
| `permission` | `master` / `owner` / `admin` / `all` | 稳定 |
| `init()` | 返回 `"return"` 跳过加载 | 稳定 |
| `accept(e)` | 预钩子 | 稳定 |
| `setContext` / `getContext` / `getContextGroup` / `finish` / `awaitContext` / `resolveContext` | 多轮对话 | 稳定 |
| `renderImg(plugin, tpl, data, cfg)` | 等价 `e.runtime.render` | 稳定 |
| `task{cron}` | 定时任务 | 稳定 |

### 2.3 全局与导出

| 项 | 说明 | 状态 |
|---|---|---|
| `segment` | icqq segment | 稳定 |
| `Bot` / `Redis` | Proxy 访问全局 | 稳定 |
| `plugin` / `Renderer` | 全局引用 | 稳定 |
| `#yunzai` | Plugin / Handler / Loader / Runtime / Renderer / renderer / puppeteer / Common / ConfigController / createLogin / Bot / Redis | 稳定 |
| `#liulian` / `#liulian.models` | 伴侣插件别名 | 稳定 |
| `#miao` / `#miao.models` | 已移除，改用 `#liulian` | 已废弃 |
| 手工调用 `puppeteer.screenshot` | 兼容保留，新代码用 `e.runtime.render` | 已废弃 |

### 2.4 事件与生命周期

- 事件：`message` / `notice` / `request` / `system.login.{qrcode,slider,device,error}` / `online` / `offline`
- `Bot.em` 逐级冒泡：先发 `message.group`，再发 `message`
- 黑名单群的消息在 `Bot.em` 入口直接丢弃，插件收不到
- 适配器接口：`{ id, name, load() }`，由 `Bot.adapter[]` 加载
- 热更新：改文件重载，增文件装载，删文件卸载

### 2.5 权限与群配置

- 权限：`master` / `owner` / `admin` / `all`
- 群配置：`botAlias` / `onlyReplyAt` / `enable` / `disable` / `groupGlobalCD` / `singleCD`

---

## 3. 可选升级（L2 / L3）

不跟进这一节，插件仍然可以收录。跟进了，插件能通过机器校验，也能获得第 5 节的更高分层。

### 3.1 L2：补齐清单与权限声明

在插件根目录放一个 `plugin.yaml`：

| 字段 | 说明 |
|---|---|
| `name` | 插件名 |
| `version` | 版本号 |
| `entry` | 入口文件 |
| `author` | 作者 |
| `source` | 仓库地址 |
| `permissions` | 权限声明，见下 |

`permissions` 支持四项，按实际填写，用不到就不写：

| 项 | 声明内容 |
|---|---|
| `fs` | 需要读写的路径范围 |
| `exec` | 需要执行的命令 |
| `net` | 需要访问的域名 |
| `master` | 功能是否需要主人身份 |

同时满足以下几条：

- 不修改全局原型，不直接改 `config/` 下的文件
- 渲染只用 `e.runtime.render`，不直接往 `temp/` 写文件
- 没有第 4 节的红线

### 3.2 L3：隔离就绪

在 `plugin.yaml` 里声明 `isolation: worker` 或 `isolation: process`，并做到：

- 不依赖进程内的全局对象（`Bot` / `redis` / `segment`），改从注入的接口取
- `fs` / `exec` / `net` 只在声明的范围内生效

运行时沙箱还没落地，这一层目前是实验状态，不承诺可用时间。

---

## 4. 安全红线

命中任意一条，不收录，也不参与排序。分数不能用来挽救红线问题。

- 后门、隐藏授权哈希、写死他人的 QQ 授权
- 没有权限门禁的 RCE、任意命令执行、把用户输入直接拿去执行
- 硬编码真实密钥、Cookie、密码
- 未声明的用户数据外传
- 从远端下载代码后解码执行
- 闭源二进制核心，或无法解释的混淆代码
- 恶意 install 钩子、供应链投毒

审计可复算，结论连同版本哈希和日期写进台账。对结论有异议可以申请重审，重审用同一套红线。

---

## 5. 收录与排序

插件能正常加载、且不命中第 4 节任一条，即收录，进入同一个池子。提交方式、审核命令和退回情形写在 `docs/engineering-workflow.md`，这里只讲收录之后怎么排。

### 5.1 分层

池内按对新规定的跟进程度分三层，这是排序的第一关键字：

| 层 | 条件 |
|---|---|
| L3 | `plugin.yaml` + 权限声明 + `isolation` |
| L2 | `plugin.yaml` + 权限声明 |
| L1 | 通过审核，没有 `plugin.yaml` |

分层只表示跟进程度，不表示安全程度。池内所有插件都已通过第 4 节。

### 5.2 评分

```
Score = 0.6 × R + 0.3 × U + 0.1 × A + P
```

| 项 | 取值 |
|---|---|
| `R` 口碑 | `min(1, log(1+stars) / log(1+K))`，K 取 GitHub 1000、Gitee 300 |
| `U` 更新 | 6 个月内 1.00；6–12 个月 0.75；1–2 年 0.50；超过 2 年 0.25 |
| `A` 资历 | `min(1, 首次提交年数 / 3)` |
| `P` 修正 | 依赖过时 −0.20；不兼容当前版本 −0.30；最低 −0.50 |

`U` 只加分不减分，功能稳定、多年不更新不会因此掉队。

排序时先比层，层内再比 Score，所以 L1 的插件即使拿到满分也排不到 L2 前面。

台账目前只有 star 数，`U` / `A` / `P` 还没有数据源，暂时按 0 计算。

### 5.3 star 的取法与缺失处理

star 随审计更新，连同日期写进台账，排序读台账里的快照，不实时请求接口。

| 情况 | 取值 |
|---|---|
| 独立仓库 | 平台内的 star 数，按对应平台的 K 归一 |
| 集合仓里的单个 JS | 仓库 star ÷ 该仓收录的插件数，标注「集合收录」 |
| 没有仓库或 0 star | 用资历和名称兜底，不扣分 |
| star 短期异常暴涨 | 记录并降权，人工复核后处理 |

不同平台的 star 不混算，Gitee 和 GitHub 各按自己的 K 归一。

### 5.4 并列与维护者插件

- 同分时先比资历，再比名称，结果是确定的
- 「最新收录」是独立视图，只显示 30 天内收录的插件，不参与主排序
- 精选位轮流展示，不长期置顶
- 维护者自己的插件用同一套公式；同分时排在后面，不进精选位

### 5.5 为什么排在这里

每个条目都能看到分项：口碑 R（star 数）、更新 U（最后提交）、资历 A（首次提交）、修正 P（标签）。点开能对着公式算出来。

---

## 6. 面板怎么显示

- 默认按第 5.2 节的顺序排：层 → Score → 资历 → 名称
- 可以切成按评分、按最近检查日期分组；「最新收录」是单独的 30 天视图
- 鼠标悬停显示 R / U / A / P 分项和数据来源
- 支持关键词搜索和类型标签筛选

---

## 7. 修订与提案

- 想法、修订、新方向统一走 Issue，不在群聊里口头定。模板：`.github/ISSUE_TEMPLATE/proposal.md`，Gitee 用户复制正文。
- 提案写清：问题、方案、影响面（兼容性和安全）、是否愿意实现。
- 公示 7 天，无反对即生效；反对要附理由。
- 只有「削弱第 2 节兼容性」和「删除第 4 节红线」两件事需要投票，且要有至少 2 名有资格者联署才启动。
- 投票启动后的规则：资格绑定仓库所有权，一人一票，单人票权不超过总票数 10%；窗口固定 7 天，开始后不加人；公开计票可复核；禁止代理投票和有偿换票；参与率不到 50% 结果无效；投票异常集中时复核并公开结论。
- 版本号 `v0.x`，破坏性改动升号，并提前一个版本公告。
- 标「可演进」的项，先告警两个版本再移除。
- 权重调整要升版本，并公示 Top N 的变化。

---

## 附录 A. 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 | 2026-10-29 | 草案：兼容基线、L2/L3、安全红线、收录与排序、修订流程 |
