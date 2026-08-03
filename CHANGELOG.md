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
 