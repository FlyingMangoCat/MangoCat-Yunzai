/**
 * QQ 官方机器人（开放平台）适配器
 *
 * 通过 WebSocket 接入 QQ 开放平台 Gateway，覆盖：
 * 单聊（C2C）、群聊 @ 消息、频道公域/私域消息、好友/群成员变动通知。
 * 鉴权使用 AppID + AppSecret 换取 AccessToken（官方已弃用静态 Token）。
 *
 * 配置：config/config/qqbot.yaml（参考 config/default_config/qqbot.yaml）
 * 平台：https://q.qq.com
 */
import fs from "node:fs"
import path from "node:path"
import yaml from "yaml"
import WebSocket from "ws"

/** 事件订阅 intents 位，与官方文档一一对应 */
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
}

const API_HOST = "https://api.bot.qq.com"

const QQBotOfficialAdapter = new (class QQBotOfficialAdapter {
  id = "QQBotOfficial"
  name = "QQ官方机器人"

  /** 账号配置 key → { appid, secret, intents } */
  accounts = []

  /** 各账号运行时状态：appid → { token, token_expire, session_id, seq, ws, heartbeat, msgId } */
  state = {}

  configPath = "config/config/qqbot.yaml"

  /**
   * 读取账号配置。文件缺失或无 accounts 时静默跳过，由 #start 提示
   */
  readConfig() {
    try {
      if (!fs.existsSync(this.configPath)) return []
      const data = yaml.parse(fs.readFileSync(this.configPath, "utf8")) || {}
      return Array.isArray(data.accounts) ? data.accounts.filter(i => i?.appid && i?.secret) : []
    } catch (err) {
      Bot.makeLog("error", [`读取 ${this.configPath} 失败`, err], this.id)
      return []
    }
  }

  stateOf(appid) {
    return (this.state[appid] ??= {
      token: "",
      token_expire: 0,
      session_id: "",
      seq: null,
      ws: null,
      heartbeat: null,
      reconnecting: false,
      last_msg_id: new Map(),
      msg_seq: 0,
      seen: new Map(),
    })
  }

  /**
   * 获取 AccessToken，过期前 120 秒自动刷新
   */
  async accessToken(appid, secret, force = false) {
    const st = this.stateOf(appid)
    if (!force && st.token && Date.now() < st.token_expire) return st.token

    const res = await fetch(`${API_HOST}/app/getAppAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: appid, clientSecret: secret }),
    }).then(i => i.json())

    if (!res.access_token) throw new Error(`获取 AccessToken 失败：${JSON.stringify(res)}`)
    st.token = res.access_token
    st.token_expire = Date.now() + (Number(res.expires_in) || 7200) * 1000 - 120000
    return st.token
  }

  /**
   * 调用官方 openapi
   */
  async request(appid, secret, method, api, body, retried = false) {
    const token = await this.accessToken(appid, secret)
    const isForm = body instanceof FormData
    const res = await fetch(`${API_HOST}${api}`, {
      method,
      headers: {
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        Authorization: `QQBot ${token}`,
      },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    /* 凭证失效时强制刷新一次后重试，避免整次调用失败 */
    if (!res.ok && !retried && [401, 403].includes(res.status)) {
      await this.accessToken(appid, secret, true)
      return this.request(appid, secret, method, api, body, true)
    }
    if (!res.ok)
      throw new Error(`API ${api} ${res.status}: ${JSON.stringify(data)}`)
    return data
  }

  /**
   * 建立 Gateway 连接。内部捕获全部异常，保证单个账号失败不影响其余账号
   */
  async connect(appid, secret, force = false) {
    const st = this.stateOf(appid)
    try {
      if (st.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(st.ws.readyState)) return

      const { url } = await this.request(appid, secret, "GET", "/gateway")
      if (!url) throw new Error("获取 Gateway 地址失败")

      const ws = new WebSocket(url)
      st.ws = ws

      ws.on("message", raw => this.message(appid, secret, String(raw)))

      ws.on("error", err => Bot.makeLog("error", [`${appid} Gateway 连接错误`, err], appid))

      ws.on("close", () => {
        if (st.heartbeat) {
          clearInterval(st.heartbeat)
          st.heartbeat = null
        }
        if (st.ws !== ws) return
        st.ws = null
        Bot.makeLog("warn", `${appid} Gateway 连接断开`, appid)
        Bot.em(`offline.${appid}`, { self_id: appid })
        if (!st.reconnecting) {
          st.reconnecting = true
          setTimeout(() => {
            st.reconnecting = false
            this.connect(appid, secret).catch(err =>
              Bot.makeLog("error", [`${appid} 重连失败`, err], appid),
            )
          }, 30000)
        }
      })

      Bot.makeLog("mark", `${this.name}(${appid}) 正在连接 Gateway`, appid)
    } catch (err) {
      Bot.makeLog("error", [`${appid} 连接失败`, err], appid)
      if (!force) {
        st.reconnecting = true
        setTimeout(() => {
          st.reconnecting = false
          this.connect(appid, secret).catch(() => {})
        }, 30000)
      }
    }
  }

  /**
   * Gateway 下行消息处理
   */
  async message(appid, secret, raw) {
    let payload
    try {
      payload = JSON.parse(raw)
    } catch (err) {
      return Bot.makeLog("error", ["解码 Gateway 数据失败", raw, err], appid)
    }
    const st = this.stateOf(appid)
    const { op, d, t, s } = payload

    switch (op) {
      case 0: {
        if (typeof s === "number") st.seq = s
        return this.dispatch(appid, t, d)
      }
      case 10: {
        /* Hello：按服务端周期发送心跳，随后鉴权 */
        const interval = d?.heartbeat_interval || 45000
        if (st.heartbeat) clearInterval(st.heartbeat)
        st.heartbeat = setInterval(() => {
          st.ws?.send(JSON.stringify({ op: 1, d: st.seq }))
        }, interval)

        const token = await this.accessToken(appid, secret)
        if (st.session_id) {
          st.ws.send(JSON.stringify({
            op: 6,
            d: { token: `QQBot ${token}`, session_id: st.session_id, seq: st.seq },
          }))
        } else {
          st.ws.send(JSON.stringify({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: st.intents ||
                INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C_EVENT | INTENTS.DIRECT_MESSAGE,
              properties: { $os: process.platform, $browser: "MangoCat-Yunzai", $device: "MangoCat-Yunzai" },
            },
          }))
        }
        return
      }
      case 11:
        return
      case 7:
        /* 服务端要求重连 */
        return st.ws?.close()
      case 9:
        /* 会话无效：清空会话，下次走 Identify */
        st.session_id = ""
        st.seq = null
        return st.ws?.close()
      default:
        Bot.makeLog("debug", `未知 opcode ${op}：${raw}`, appid)
    }
  }

  /**
   * 事件分发：把官方事件映射为本体事件结构后派发
   */
  dispatch(appid, type, d) {
    const bot = Bot[appid]
    if (!bot) {
      Bot.makeLog("warn", `收到事件 ${type} 但账号 ${appid} 未就绪`, appid)
      return
    }
    /* 官方会为确保可达重复推送相同 msg_id 的消息事件，需去重 */
    if (d?.id && type?.endsWith("MESSAGE_CREATE")) {
      const st = this.stateOf(appid)
      if (st.seen.has(d.id)) return
      st.seen.set(d.id, 1)
      if (st.seen.size > 500) {
        const keys = st.seen.keys()
        while (st.seen.size > 400) st.seen.delete(keys.next().value)
      }
    }
    switch (type) {
      case "READY":
        this.onReady(appid, d)
        return
      case "RESUMED":
        Bot.makeLog("mark", `${appid} 会话已恢复`, appid)
        return
      case "C2C_MESSAGE_CREATE":
        return this.onC2CMessage(bot, d)
      case "GROUP_AT_MESSAGE_CREATE":
        return this.onGroupMessage(bot, d)
      case "DIRECT_MESSAGE_CREATE":
        return this.onDirectMessage(bot, d)
      case "AT_MESSAGE_CREATE":
      case "MESSAGE_CREATE":
        return this.onGuildMessage(bot, d, type === "MESSAGE_CREATE")
      case "FRIEND_ADD":
        return Bot.em("notice.friend.add", {
          bot,
          self_id: appid,
          post_type: "notice",
          notice_type: "friend",
          sub_type: "add",
          user_id: d?.openid,
          time: Math.floor(Date.now() / 1000),
        })
      case "FRIEND_DEL":
        bot.fl.delete(d?.openid)
        Bot.makeLog("info", `用户删除机器人：${d?.openid}`, appid)
        return
      case "GROUP_ADD_ROBOT":
        Bot.makeLog("info", `机器人被加入群：${d?.group_openid}`, appid)
        return
      case "GROUP_DEL_ROBOT":
        bot.gl.delete(d?.group_openid)
        Bot.makeLog("info", `机器人被移出群：${d?.group_openid}`, appid)
        return
      case "C2C_MSG_REJECT":
      case "C2C_MSG_RECEIVE":
      case "GROUP_MSG_REJECT":
      case "GROUP_MSG_RECEIVE":
        Bot.makeLog("info", `${type}：${d?.group_openid || d?.user_openid || ""}`, appid)
        return
      default:
        Bot.makeLog("debug", `未处理事件 ${type}：${JSON.stringify(d)}`, appid)
    }
  }

  onReady(appid, d) {
    const st = this.stateOf(appid)
    st.session_id = d.session_id
    const bot = Bot[appid]
    if (bot) {
      bot.info = d.user
      bot.fl.clear()
      bot.gl.clear()
    }
    Bot.makeLog("mark", `${this.name}(${appid}) 已连接，用户：${d.user?.username}`, appid)
    Bot.em(`connect.${appid}`, { self_id: appid, bot })
  }

  /** 官方时间戳（RFC3339）转秒级 Unix；解析失败回退当前时间 */
  parseTime(ts) {
    const t = ts ? new Date(ts).getTime() : NaN
    return Number.isNaN(t) ? Math.floor(Date.now() / 1000) : Math.floor(t / 1000)
  }

  /** 附件（图片）转 Yunzai 图片段 */
  attachmentSegs(d) {
    const segs = []
    for (const att of d?.attachments || []) {
      if (att.content_type?.startsWith("image") && att.url)
        segs.push({ type: "image", file: att.url, name: att.filename })
    }
    return segs
  }

  /**
   * 组装单聊（C2C / 频道私信）消息事件
   */
  privateEvent(bot, d, userId) {
    const st = this.stateOf(bot.uin)
    if (d.id) st.last_msg_id.set(userId, d.id)
    const content = String(d.content ?? "").trim()
    const message = []
    if (content) message.push({ type: "text", text: content })
    message.push(...this.attachmentSegs(d))
    return {
      bot,
      self_id: bot.uin,
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: d.id,
      user_id: userId,
      seq: d.seq,
      time: this.parseTime(d.timestamp),
      sender: {
        user_id: userId,
        nickname: d.author?.username || "QQ用户",
      },
      message,
      raw_message: content,
      self_message_id: d.id,
    }
  }

  onC2CMessage(bot, d) {
    const userId = d.author?.user_openid || d.author?.id
    const data = this.privateEvent(bot, d, userId)
    Bot.makeLog("info", `好友消息：${data.raw_message}`, `${bot.uin} <= ${userId}`, true)
    Bot.em("message.private.friend", data)
  }

  onDirectMessage(bot, d) {
    const userId = d.author?.id
    const data = this.privateEvent(bot, d, userId)
    data.guild_id = d.guild_id
    Bot.makeLog("info", `频道私信：${data.raw_message}`, `${bot.uin} <= ${userId}`, true)
    Bot.em("message.private.friend", data)
  }

  onGroupMessage(bot, d) {
    const groupId = d.group_openid
    const userId = d.author?.member_openid || d.author?.user_openid || d.author?.id
    const st = this.stateOf(bot.uin)
    if (d.id) st.last_msg_id.set(groupId, d.id)
    const nickname = d.author?.member_nickname || d.author?.username || "QQ用户"
    const content = String(d.content ?? "").trim()
    const message = []
    if (content) message.push({ type: "text", text: content })
    message.push(...this.attachmentSegs(d))
    const data = {
      bot,
      self_id: bot.uin,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: d.id,
      group_id: groupId,
      user_id: userId,
      time: this.parseTime(d.timestamp),
      sender: {
        user_id: userId,
        card: nickname,
        nickname,
      },
      message,
      raw_message: content,
      self_message_id: d.id,
    }
    Bot.makeLog("info", `群消息：${data.raw_message}`, `${bot.uin} <= ${groupId}, ${userId}`, true)
    Bot.em("message.group.normal", data)
  }

  /**
   * 频道消息（公域 AT_MESSAGE_CREATE / 私域 MESSAGE_CREATE）
   */
  onGuildMessage(bot, d, isPrivate) {
    const groupId = `${d.guild_id}-${d.channel_id}`
    const st = this.stateOf(bot.uin)
    if (d.id) st.last_msg_id.set(groupId, d.id)

    const message = []
    if (d.content) message.push({ type: "text", text: d.content })
    for (const att of d.attachments || []) {
      if (att.content_type?.startsWith("image"))
        message.push({ type: "image", file: att.url, name: att.filename })
    }
    const raw_message = d.content + (d.attachments || []).map(i => `\n[图片：${i.filename}]`).join("")

    const data = {
      bot,
      self_id: bot.uin,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: d.id,
      guild_id: d.guild_id,
      channel_id: d.channel_id,
      group_id: groupId,
      user_id: d.author?.id,
      time: Math.floor(Date.now() / 1000),
      sender: {
        user_id: d.author?.id,
        card: d.author?.username,
        nickname: d.author?.username,
      },
      message,
      raw_message,
      private_domain: isPrivate,
    }
    Object.defineProperty(data, "friend", {
      get() {
        return this.member || {}
      },
    })
    Bot.makeLog("info", `频道消息：${raw_message}`, `${bot.uin} <= ${groupId}, ${d.author?.id}`, true)
    Bot.em("message.group.normal", data)
  }

  /**
   * 注册账号到 Bot，构造 pickFriend / pickGroup 等统一接口
   */
  registerBot(appid, secret) {
    if (Bot[appid]) return
    Bot[appid] = {
      adapter: this,
      info: {},
      get uin() {
        return appid
      },
      get nickname() {
        return this.info?.username || this.name
      },
      get avatar() {
        return `https://q.qlogo.cn/g?b=qq&s=0&nk=${appid}`
      },
      version: {
        id: this.id,
        name: this.name,
        version: "v2",
      },
      stat: { start_time: Math.floor(Date.now() / 1000) },

      fl: new Map(),
      gl: new Map(),
      gml: new Map(),

      pickFriend: this.pickFriend.bind(this, appid, secret),
      get pickUser() {
        return this.pickFriend
      },
      pickGroup: this.pickGroup.bind(this, appid, secret),
      get pickMember() {
        return this.pickFriend
      },
      getGroupArray() {
        return [...Bot[appid].gl.keys()]
      },
      getFriendArray() {
        return [...Bot[appid].fl.keys()]
      },
      cookies: {},
      getCookies() {},
      getCsrfToken() {},
    }
    if (!Bot.uins.includes(appid)) Bot.uins.push(appid)
  }

  /**
   * 发送消息到单聊或群聊。msg 为 Yunzai 段数组，支持 text / at / image / reply / node
   */
  async sendMsg(appid, secret, kind, id, msg) {
    const st = this.stateOf(appid)
    const isGroup = kind === "group"
    const msgId = st.last_msg_id.get(id)

    if (!Array.isArray(msg)) msg = [msg]

    let content = ""
    let media = []
    let replyId = ""

    const upload = async file => {
      /* 富媒体上传：本地/内网 URL 腾讯侧无法下载（40093007/40093010），
         按官方文档二进制直传字段为 file_data（base64）+ file_name，5MB 内可用；
         仅当拿不到内容时才把 URL 交给腾讯侧下载 */
      const buf = await Bot.Buffer(file)
      Bot.makeLog("debug", [`官机富媒体上传`, Buffer.isBuffer(buf) ? `Buffer ${buf.length} 字节` : String(buf)], appid)
      const body = { file_type: 1, srv_send_msg: false }
      if (Buffer.isBuffer(buf)) {
        body.file_data = buf.toString("base64")
        body.file_name = `image.${(await Bot.fileType(file))?.type?.ext || "png"}`
      } else {
        body.url = String(buf)
      }
      const res = await this.request(
        appid, secret, "POST",
        isGroup ? `/v2/groups/${id}/files` : `/v2/users/${id}/files`,
        body,
      )
      return res.file_info
    }

    for (const i of msg) {
      if (typeof i !== "object") {
        content += i
        continue
      }
      switch (i.type) {
        case "text":
          content += i.text
          break
        case "image":
          media.push(await upload(i))
          break
        case "reply":
          replyId = i.id
          break
        case "at":
          /* 单聊/群聊不支持 at 段，降级为文本；频道走 guild 发送分支 */
          content += `@${i.text || i.id}`
          break
        case "node":
          for (const j of i.data) {
            const t = typeof j.message === "object" && !Array.isArray(j.message) ? j.message : j.message
            content += `${typeof t === "string" ? t : ""}\n`
          }
          break
        case "face":
        case "record":
        case "video":
        case "file":
        case "forward":
          Bot.makeLog("warn", `${this.name} 不支持发送 ${i.type} 消息段`, appid)
          break
        default:
          content += typeof i === "string" ? i : ""
      }
    }

    const body = {
      content,
      msg_type: media.length ? 7 : 0,
      msg_id: replyId || msgId || "",
      msg_seq: st.msg_seq++,
    }
    if (media.length) body.media = { file_info: media[0] }

    const api = isGroup ? `/v2/groups/${id}/messages` : `/v2/users/${id}/messages`
    const res = await this.request(appid, secret, "POST", api, body)
    if (!msgId)
      Bot.makeLog("debug", `${this.name} 当前无被动回复窗口，消息可能被平台限额拦截`, appid)
    return { message_id: res.id || res.msg?.id || Date.now().toString(36) }
  }

  /**
   * 频道消息发送
   */
  sendGuildMsg(appid, secret, channelId, msg) {
    let content = ""
    for (const i of Array.isArray(msg) ? msg : [msg]) {
      if (typeof i === "object") {
        if (i.type === "text") content += i.text
        else if (i.type === "at") content += `<@${i.id}>`
      } else content += i
    }
    return this.request(appid, secret, "POST", `/channels/${channelId}/messages`, { content })
  }

  /**
   * 撤回单聊/群聊消息（官方 DELETE 端点）
   */
  recall(appid, secret, kind, id, message_id) {
    const api =
      kind === "group"
        ? `/v2/groups/${id}/messages/${message_id}`
        : `/v2/users/${id}/messages/${message_id}`
    return this.request(appid, secret, "DELETE", api)
  }

  pickFriend(appid, secret, userId) {
    const adapter = this
    return {
      adapter,
      user_id: userId,
      sendMsg: msg => adapter.sendMsg(appid, secret, "user", userId, msg),
      recallMsg: message_id => adapter.recall(appid, secret, "user", userId, message_id),
      sendFile: file => adapter.sendMsg(appid, secret, "user", userId, [{ type: "image", file }]),
      getInfo: () => Bot[appid].fl.get(userId) || { user_id: userId, nickname: "QQ用户" },
      getSimpleInfo() {
        return this.getInfo()
      },
      getAvatarUrl: () => `https://q.qlogo.cn/g?b=qq&s=0&nk=${userId}`,
      get is_friend() {
        return true
      },
    }
  }

  pickGroup(appid, secret, groupId) {
    const adapter = this
    return {
      adapter,
      group_id: groupId,
      sendMsg: msg => adapter.sendMsg(appid, secret, "group", groupId, msg),
      recallMsg: message_id => adapter.recall(appid, secret, "group", groupId, message_id),
      sendFile: file => adapter.sendMsg(appid, secret, "group", groupId, [{ type: "image", file }]),
      getInfo: () => Bot[appid].gl.get(groupId) || { group_id: groupId, group_name: "QQ群" },
      pickMember: () => ({
        ...this.pickFriend(appid, secret, groupId),
        getInfo: () => ({ user_id: groupId }),
        get is_owner() {
          return false
        },
        get is_admin() {
          return false
        },
      }),
      getAvatarUrl: () => "",
      get is_owner() {
        return false
      },
      get is_admin() {
        return false
      },
    }
  }

  logRecall(appid) {
    Bot.makeLog("warn", `${this.name} 暂不支持撤回消息`, appid)
  }

  async load() {
    this.accounts = this.readConfig()
    if (!this.accounts.length) {
      Bot.makeLog("info", `${this.name} 未配置账号（config/config/qqbot.yaml），跳过加载`, this.id)
      return
    }
    for (const acc of this.accounts) {
      const appid = String(acc.appid)
      if (acc.intents) this.stateOf(appid).intents = acc.intents
      this.registerBot(appid, acc.secret)
      await this.connect(appid, acc.secret).catch(err =>
        Bot.makeLog("error", [`${appid} 首次连接失败`, err], appid),
      )
    }
  }
})()

Bot.adapter.push(QQBotOfficialAdapter)
export { QQBotOfficialAdapter }
