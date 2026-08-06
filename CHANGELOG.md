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
 