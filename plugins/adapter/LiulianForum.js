import WebSocket from "ws"
import cfg from "../../lib/config/config.js"
import { OneBotv11Adapter } from "./OneBotv11.js"

/* 榴莲论坛开放平台适配器：正向 WebSocket 客户端
 * 平台侧为 WS 服务端（/api/bot/ws?access_token=xxx），本适配器作为客户端主动连接，
 * 事件解析与 API 调用全部复用 OneBotv11 适配器的实现，仅重写连接方式。
 * 注意：基类 connect(data, ws) 负责 lifecycle 事件时的 Bot 注册，不可覆盖。
 */
const LiulianForumAdapter = Object.create(OneBotv11Adapter)

LiulianForumAdapter.id = "LiulianForum"
LiulianForumAdapter.name = "LiulianForum"
LiulianForumAdapter.path = "LiulianForum"
LiulianForumAdapter.timeout = 60000

// 重连间隔（毫秒）
LiulianForumAdapter.reconnectDelay = 5000

// 出站建连（命名避开基类 connect，connect 留给基类做 Bot 注册）
LiulianForumAdapter.wsConnect = function () {
  const { url, token } = cfg.forum
  if (!url || !token) {
    Bot.makeLog("warn", "未配置 url 或 token，跳过连接", this.name)
    return
  }
  if (cfg.forum.reconnect) this.reconnectDelay = cfg.forum.reconnect * 1000
  const ws = new WebSocket(`${url.replace(/\/$/, "")}/ws?access_token=${token}`)
  // 适配基类 sendApi 的 ws.sendMsg 调用方式
  const client = {
    sendMsg: data => ws.send(JSON.stringify(data)),
  }

  ws.on("open", () => {
    Bot.makeLog("mark", `${this.name} 已连接 ${url}`, this.name)
    // 平台连接后会推送 lifecycle 元事件，走基类 makeMeta → connect 完成 Bot 注册
  })

  ws.on("message", data => this.message(data, client))

  ws.on("error", err => {
    Bot.makeLog("error", [`${this.name} 连接错误`, err], this.name)
  })

  ws.on("close", (code, reason) => {
    Bot.makeLog(
      "warn",
      [`${this.name} 连接断开，${this.reconnectDelay / 1000} 秒后重连`, code, reason.toString()],
      this.name,
    )
    setTimeout(() => this.wsConnect(), this.reconnectDelay)
  })
}

LiulianForumAdapter.load = function () {
  this.wsConnect()
}

Bot.adapter.push(LiulianForumAdapter)
export { LiulianForumAdapter }
