 # 3.2.1

 * `稳定性与安全修复`更新
 * 修复：`sendMasterMsg` 在 `cfg.master` 未定义时崩溃（主人通知）
   * 新增 `cfg.master` getter，兼容 TRSS 的 `master: {bot_id:[qq]}` 格式，未配置时回退为 `{bot_id: masterQQ}` 结构
   * `sendMasterMsg` 默认参数加双保险 `Object.keys(cfg.master || {})`
   * `notifyMaster` 容错：`masterQQ` 未配置时直接返回，不提示不崩溃
 * 修复：OneBot 连接流程请求超时不再崩溃
   * 多处 `.catch(i => i.error)` 后直接访问属性（`.data`/`.cookies`/`.token`），超时返回 undefined 时崩溃
   * 改为 `.catch(() => ({}))` 空对象兜底，超时/失败不崩，正常返回数据照常获取
 * 修复：清洗/危险操作通报在 Bot 未连接时丢失
   * `broadcast`/`notifyMaster` 在插件加载阶段（群列表为空/uin 为空）不再静默丢弃
   * 待补发队列 + 3 秒轮询，连接就绪后自动补发群广播与私信主人，最多等待 2 分钟
 * 修复：`initCfg` 默认配置缺失时静默重建丢失自定义配置
   * 目录已存在但默认配置文件缺失（疑似被 git 删除/误删，非全新部署）时打印告警提示检查
   * logger 未初始化时用 console 兜底打印，确保告警必达
 * 修复：插件清洗覆盖后安装/热更新路径，确保后门必被清洗
   * `load()` 每次进入先全量扫描 `plugins/` 目录执行清洗（`scanAllPlugins`），不再因插件列表非空跳过
   * watch 的 change/add 热更新回调补上清洗，后安装/更新插件也触发
 * 新增：每次重启后通报插件安全状态
   * 清洗记录持久化到 `data/pluginScanHistory.json`（保留最近 100 条）
   * 每次重启后私信主人通报插件安全状态（含历史累计清洗记录），即使本次无新后门也通报
 * 修复：用户配置文件移出 git 跟踪
   * `config/config/` 下用户配置文件（bot/group/notice/qq/redis.yaml）移除 git 跟踪，避免本机配置被推送泄露及 pull 冲突
   * `initCfg` 复制默认配置前先确保 `config/config/` 目录存在（git 不跟踪空目录，新克隆可能缺失）
 * 修复：`#更新抽卡记录` 指令正则与 uid 取值
   * 指令正则修正为 `#*(星铁|崩坏星穹铁道|铁道)更新抽卡记录`
   * `getAuthKeyFromCookie` uid 优先读用户主 uid（星铁 `_games.sr.uid`/原神 `_games.gs.uid`），与 `#uid` 显示一致，cookie 列表兜底
 * 修复：重启流程 `execve` 失败回退，新进程接管控制台、老进程可靠退出
   * `execve` 包 try/catch：平台不支持/抛错时记录 warn 并回退常规重启，不再中断流程导致老进程不退出
   * 前台模式改用 spawn + stdio inherit 启动新进程接管终端，替代 exec 管道方式
   * `cmdStart` 加 `unref`，新进程独立于旧进程句柄

 # 3.2.0 

 * `安全防护`更新
 * 新增：黑名单群消息入口掐断
   * 黑名单群的消息在事件分发入口（`Bot.em` 与 icqq 通道）直接丢弃，插件完全拿不到消息，无法响应
   * 仅拦截黑名单群，普通群不受影响；白名单优先、黑名单其次，与既有配置语义一致
 * 新增：数据保护层（`lib/config/fsGuard.js`）
   * 拦截插件删除 `config/`、`data` 根、`data/db/`、本体核心文件（`app.js`/`lib/`/`package.json` 等）及项目根/逃逸路径（`../`、跨盘符、`rm -rf /`），命中即阻止
   * 删除 `data/` 下其他内容前自动备份到备份目录（`dataBackupPath`，默认 `.backup/`），可恢复
   * 包装 `fs` 全部删除与写入方法（同步/异步/promises），调用者来自插件目录即生效
   * 保护 `config/config/other.yaml` 关键字段（`masterQQ`/`whiteGroup`/`blackGroup`/`blackQQ`），禁止插件修改，命中阻止并通报
 * 新增：命令执行保护层（`lib/config/cmdGuard.js`）
   * 拦截插件执行 `rm` 删除核心目录/逃逸路径、`curl|bash`、`wget|sh`、`bash <(curl ...)` 等危险命令
   * 包装 `child_process` 全部执行方法（exec/execFile/spawn 及同步版）与 `util.exec`（`Bot.exec` 路径），插件正常命令放行
   * 插件执行命令时私信主人风险提示（同插件 10 分钟节流），高危命令全群广播点名曝光
 * 新增：插件硬编码后门检测与清洗（`lib/config/pluginScan.js`）
   * 检测三类硬编码后门载体：`data:text/javascript` 内联代码、`md5(user_id)` 哈希字面量授权比较、v8 序列化隐藏授权文件
   * 检测到后门时自动清洗源码（仅删后门行/隐藏授权文件，其余代码不动），插件正常功能保留
   * 新增格式级检测：识别「对 user_id 做哈希后与硬编码值比较放行」的通用授权格式，不依赖具体载体（内联/隐藏文件/JSON/远程拉取）与哈希算法（md5/sha256/封装改名均可识别）
   * 解码硬编码后门中的隐藏管理员 QQ 号并如实曝光（见下文说明）
 * 新增：危险操作全群通报
   * 极度危险操作（删除核心目录/危险命令/木马病毒）向所有群广播点名，按黑白名单过滤通知群：配置了白名单只通知白名单群，黑名单群跳过
 * 新增：更新流程冲突处理
   * 清洗修改后自动提交到插件自身 git 仓库（独立仓库插件），避免后续 `git pull` 因本地修改被拒/冲突
   * `#更新` 时 pull 前自动提交本地未提交改动（含清洗改动），更新后重启自动对最新代码重新清洗
 * 说明：在生态插件的公开源码中发现硬编码「隐藏管理员」授权（静默驻留、触发即远程操控的木马特征），对应授权 QQ 已解码确认，并已在安装/更新时自动清洗后门并全群通报，请及时检查本地插件目录
   * 隐藏管理员授权 QQ 号：`746659424`、`1509293009`、`2536554304`、`3139373986`、`2173302144`

 # 3.1.10

 * 修复：`get_group_msg_history` / `get_friend_msg_history` / `get_forward_msg` 拉取大响应（如 11 万+ 条历史消息）时因默认 60s 超时被 reject，功能不可用
   * `sendApi` 支持 per-request `timeout` 参数，历史消息/转发消息接口超时放宽到 300s
   * 修正超时定时器变量清理（`clearTimeout(timer)`），避免正常返回后定时器仍触发

 # 3.1.9

 * 修复：日志标识残留
   * `lib/util.js` `makeLogID` 兜底默认值
   * OneBotv11 上报的 `model`
   * `#版本` 卡片名称
 * 修复：OneBot 适配器单个请求超时后 `ws.terminate()` 掐断连接，导致其他 pending 请求连锁超时（"请求超时"+"发送消息错误"）
   * 超时只 reject 当前请求，不再断开连接，避免雪崩
 * 修复：迟到的 API 响应（请求已超时、echo 已删除）被误报为"未知消息"刷屏
   * echo 匹配不到的响应降级为 debug 日志，不再 warn

 # 3.1.8

 * 修复：前台运行（node .）下 `#重启` / `#更新` 自动重启后控制台卡死（键盘输入与 Ctrl+C 全部失效），但 bot 本体收发指令正常
   * 根因：`util.cmdStart` 在 Windows 上执行 `cmd /c start "" node app.js` 且 spawn 带 `detached: true`，新进程被放入独立进程组，收不到控制台 Ctrl+C 信号；旧进程退出前也未关闭 stdin readline，终端 raw mode 未恢复，导致控制台完全失控
   * `util.cmdStart` 去掉 `cmd /c start` 包装与 `detached`（所有平台生效），改为直接 spawn 且与当前进程同组，新进程接管当前控制台窗口，Ctrl+C 等信号可正常送达
   * `Bot.restart()` internal 分支调整顺序：先创建新进程，退出前再关闭 stdin readline（先移除 close 监听避免触发 Bot.exit），恢复终端 raw mode
   * Linux/macOS 前台正常路径走 `process.execve` 原地替换进程映像（无新进程，本无此问题）；旧版 Node 无 execve 时 fallback 到 cmdStart，同样受益于去 detached 修复
 * 说明：pm2 启动方式（`pnpm start`）不受影响，仍走 `pnpm run restart` 分支

 # 3.1.7

 * 修复：绑定 cookie 后未调用 `reqMysUid()`，新用户 uid 未按游戏（原神/星铁/绝区零）落库，导致 `#uid` 显示不全、星铁/绝区零功能报"请先绑定uid"
   * `bing()` 补回 `mys.reqMysUid()` 调用，失败时回滚并提示
   * 补回被误删的 `MysUser.getCkUid()` 静态方法（`#检查ck` 依赖）
 * 修复：`#米游社更新面板` / `#mys更新面板` 被米游社公告搜索规则误拦截，当作搜索词处理
   * `mysNews` 入口规则负向前瞻排除面板更新类命令，`mysSearch()` 内部加兜底
 * 修复：`*uid2` 等星铁命令无反应
   * loader `srReg` 补 `*` 前缀及星铁别名，星铁命令标准化为 `#星铁` 开头
   * `srReg` 改为开头锚定，修复旧版无锚点正则把 `#星铁xxx` 重复替换成 `##星铁xxx` 的问题
   * uid 规则支持 `(原神|星铁|绝区零)?` 前缀
   * `toggleUid` 按 `e.game` 切换对应游戏，不再写死原神
 * 修复：liulian-plugin 版本日志读取不到根目录 `CHANGELOG.md`，渲染空图
   * `Changelog (2).js` 路径拼接补 `/`，版本标题与条目正则兼容行首空格
 * 修复：`#星铁更新抽卡记录` 被星铁plugin抢处理，未绑定抽卡链接时提示"链接已过期"，本体用已绑 cookie 自动获取 authkey 的流程没机会跑
   * loader 回复钩子检测到"抽卡链接已过期"提示时，拦截并劫持到本体 `gcLog.updateGachaLog()` 流程
   * 劫持时按消息内容恢复星铁标记，避免 `getAuthKeyFromCookie()` 查成原神 uid
 * 修复：`#抽卡记录` / `#*全部记录` / 池统计渲染出图片但未发送
   * `gcLog` 的 `getLog`/`logCount` 用 `retType: "base64"` 只渲染不发送，图片被丢弃
   * 照参考版补 `this.button` 快捷按钮，并用 `this.reply([base64, button])` 发送
 * 修复：pm2 启动时 `process.argv[1]` 是 app.js 路径不含 "pm2"，导致重启耗时消息不发送、`start_type` 误判为 internal
   * `app.js` / `restart.js` 改用 `process.env.app_type === "pm2"` 判断，重启后正常发送"重启成功：耗时xx秒"

 # 3.1.6

 * 新增：`#扫码登录` / `#扫码终止` 命令，扫码登录米哈游账号自动绑定 cookie 与 stoken
   * 调米哈游 passport API 生成二维码并轮询登录状态
   * 扫码成功后调用 MangoCat 原生 `User.bing()` 绑定流程，保障与下游插件兼容
   * stoken 独立写入 `MysUserDB.stoken` 字段，供抽卡记录等场景直接读取
 * 新增：`MysUserDB` 新增 `stoken` 字段，`BaseModel.syncWithAlter()` 对已存在的表自动 ALTER TABLE ADD COLUMN 补齐缺失列
 * 优化：`gachaLog.getAuthKeyFromCookie()` 优先从存档 `stoken` 字段读取，读不到再 fallback 到 `login_ticket` 换取
 * 修复：扫码轮询使用不存在的 `lodash.sleep` 导致高速死循环打 API
 * 修复：SQLite 已存在表新增字段时 `no such column: stoken` 错误

 # 3.1.5

 * 新增：`#星铁更新抽卡记录` 命令，通过已绑定的米游社 cookie 自动获取 authkey 更新星铁抽卡记录
   * 从 cookie 提取 login_ticket 换取 stoken
   * 通过 genAuthKey API 获取抽卡 authkey
   * 无需手动从游戏复制抽卡链接
 * 修复：GachaLog 构造函数未识别 `e.game === "sr"`，导致星铁命令用错 gameBiz/region
 * 优化：绑定 cookie 时同时保存 stoken 和 login_ticket 字段

 # 3.1.4

 * 修复：启动时缺少 `MysInfo.initCache()` 调用，导致插件通过UID查找Cookie失败
 * 优化：`checkLimit` 增加消息去重机制(msgThrottle)，防止QQ协议重复投递导致的卡顿
 * 优化：将 `eventMap` 从 `filtEvent` 方法内移到构造函数，避免每次调用重复创建对象
 * 优化：星铁检测正则从 `dealMsg` 方法内移到构造函数，避免每次调用重复编译
 * 优化：去除 `dealMsg` 中多余的 `.trim()` 调用

 # 3.1.3

 * 修复：补充设备指纹(getFp)接口和 device_fp 请求头，修复米游社API风控拒绝连接问题

 # 3.0.1

 * 新增`版本`

 # 0.0.0

 * 芒果猫
 