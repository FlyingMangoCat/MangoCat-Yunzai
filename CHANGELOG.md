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
 