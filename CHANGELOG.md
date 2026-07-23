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
 