/**
 * OneBot v11 协议适配器
 *
 * 协议文档：https://github.com/botuniverse/onebot-11（公开标准）
 * 本实现面向本体的多账号结构编写：ws 服务端接入、事件映射、
 * openapi 调用与好友/群/成员对象封装均为独立实现。
 */
import cfg from "../../lib/config/config.js"
import path from "node:path"
import { ulid } from "ulid"

class OneBotv11Adapter {
  id = "QQ"
  name = "OneBotv11"
  path = this.name
  /** echo → 待响应的 api 请求 */
  pending = new Map()
  timeout = 60000

  /** 日志内容格式化 */
  textOf(msg) {
    return Bot.String(msg)
  }

  /**
   * 调用 OneBot openapi
   * 单个请求超时仅丢弃本次请求，不终止连接（terminate 会连带其余 pending 请求）
   * @returns {Promise} 返回响应 data；data 为空对象时展开为 null，便于可选链
   */
  async callApi(data, ws, action, params = {}, timeout = this.timeout) {
    const echo = ulid()
    const request = { action, params, echo }
    const pending = Promise.withResolvers()
    this.pending.set(echo, pending)
    const timer = setTimeout(() => {
      pending.reject(new Error(`openapi ${action} 响应超时（${timeout}ms）`))
      Bot.makeLog("error", [`openapi ${action} 响应超时`, params], data.self_id)
    }, timeout)

    ws.sendMsg(request)

    return pending.promise
      .then(result => {
        if (result?.status === "failed" || result?.message) {
          throw Bot.makeError(`openapi ${action} 失败`, result)
        }
        return result.data ?? result
      })
      .finally(() => {
        clearTimeout(timer)
        this.pending.delete(echo)
      })
  }

  /** openapi 响应分发：echo 命中则 resolve，迟到的响应降级为 debug */
  resolveApi(data, ws) {
    try {
      data = { ...JSON.parse(data), raw: Bot.String(data) }
    } catch (err) {
      return logger.error(["OneBotv11 数据解码失败", data, err])
    }

    if (data.echo) {
      const pending = this.pending.get(data.echo)
      if (pending) return pending.resolve(data)
      return logger.debug(`[OneBotv11] 迟到的 api 响应：${Bot.String(data.raw)}`)
    }

    if (data.post_type) {
      if (data.meta_event_type !== "lifecycle" && !Bot.uins.includes(data.self_id)) {
        return logger.warn(`[OneBotv11] 未注册的账号消息：${Bot.String(data.raw)}`)
      }
      data.bot = Bot[data.self_id]
      this.handleEvent(data, ws)
      return
    }

    logger.warn(`[OneBotv11] 未知数据：${Bot.String(data.raw)}`)
  }

  /**
   * 消息/事件入口
   */
  handleEvent(data, ws) {
    switch (data.post_type) {
      case "meta_event":
        return this.handleMeta(data, ws)
      case "message":
        return this.dispatchMessage(data)
      case "notice":
        return this.dispatchNotice(data)
      case "request":
        return this.dispatchRequest(data)
      case "message_sent":
        data.post_type = "message"
        return this.dispatchMessage(data)
    }
  }

  /** 处理心跳 */
  applyHeartbeat(data) {
    if (data.status) Object.assign(data.bot.stat, data.status)
  }

  /** 元事件：心跳与连接生命周期 */
  handleMeta(data, ws) {
    switch (data.meta_event_type) {
      case "heartbeat":
        return this.applyHeartbeat(data)
      case "lifecycle":
        return this.registerBot(data, ws)
      default:
        logger.warn(`[OneBotv11] 未知元事件：${Bot.String(data.raw)}`)
    }
  }

  /** 文件段转 OneBot file 参数：Buffer 转 base64，其余原样 */
  async toFileTarget(file, opts) {
    file = await Bot.Buffer(file, {
      http: true,
      size: 10485760,
      ...opts,
    })
    if (Buffer.isBuffer(file)) return `base64://${file.toString("base64")}`
    return file
  }

  /**
   * 将本体消息段数组转换为 OneBot 消息段数组
   * @param msg 本体消息段
   * @param splitFile 是否将 file 段剥离为独立文件上传项
   *   （send_msg 走剥离；合并转发节点保留 file 段内联，节点没有上传 API）
   * @returns {{ segments: [], nodes: [], files: [] }}
   */
  async buildMessage(msg, splitFile = true) {
    if (!Array.isArray(msg)) msg = [msg]
    const segments = []
    const nodes = []
    const files = []
    for (let seg of msg) {
      if (typeof seg !== "object") seg = { type: "text", data: { text: seg } }
      else if (!seg.data) seg = { type: seg.type, data: { ...seg, type: undefined } }

      switch (seg.type) {
        case "at":
          if (seg.data.id != null) seg.data.id = String(seg.data.id)
          seg.data.qq = String(seg.data.id ?? seg.data.qq)
          break
        case "reply":
          seg.data.id = String(seg.data.id)
          break
        case "button":
          continue
        case "node":
          nodes.push(...seg.data)
          continue
        case "file":
          if (splitFile) {
            files.push({ file: seg.data.file, name: seg.data.name })
            continue
          }
          break
        case "raw":
          seg = seg.data
          break
      }

      if (seg.data?.file) seg.data.file = await this.toFileTarget(seg.data.file)

      segments.push(seg)
    }
    return { segments, nodes, files }
  }

  /**
   * 发送管线：合并转发节点、剥离的文件、正文消息依次发出
   * @returns 无多段时返回单条结果，否则返回 { data, message_id }
   */
  async sendOut(msg, send, sendForwardMsg, sendFile) {
    /** 无专用上传回调时（如频道）保持 file 段内联，不静默丢弃 */
    const { segments, nodes, files } = await this.buildMessage(msg, Boolean(sendFile))
    const ret = []

    if (nodes.length) {
      const data = await sendForwardMsg(nodes)
      if (Array.isArray(data)) ret.push(...data)
      else ret.push(data)
    }

    for (const { file, name } of files) ret.push(await sendFile(file, name))

    if (segments.length) ret.push(await send(segments))
    if (ret.length === 1) return ret[0]

    const message_id = []
    for (const i of ret) if (i?.message_id) message_id.push(i.message_id)
    return { data: ret, message_id }
  }

  sendToFriend(data, msg) {
    return this.sendOut(
      msg,
      message => {
        Bot.makeLog(
          "info",
          `发送好友消息：${this.textOf(message)}`,
          `${data.self_id} => ${data.user_id}`,
          true,
        )
        return data.bot.callApi("send_msg", {
          user_id: data.user_id,
          message,
        })
      },
      nodes => this.sendFriendForward(data, nodes),
      (file, name) => this.sendFriendFile(data, file, name),
    )
  }

  sendToGroup(data, msg) {
    return this.sendOut(
      msg,
      message => {
        Bot.makeLog(
          "info",
          `发送群消息：${this.textOf(message)}`,
          `${data.self_id} => ${data.group_id}`,
          true,
        )
        return data.bot.callApi("send_msg", {
          group_id: data.group_id,
          message,
        })
      },
      nodes => this.sendGroupForward(data, nodes),
      (file, name) => this.sendGroupFile(data, file, undefined, name),
    )
  }

  sendToGuild(data, msg) {
    return this.sendOut(
      msg,
      message => {
        Bot.makeLog(
          "info",
          `发送频道消息：${this.textOf(message)}`,
          `${data.self_id}] => ${data.guild_id}-${data.channel_id}`,
          true,
        )
        return data.bot.callApi("send_guild_channel_msg", {
          guild_id: data.guild_id,
          channel_id: data.channel_id,
          message,
        })
      },
      nodes => Bot.sendForwardMsg(msg => this.sendToGuild(data, msg), nodes),
    )
  }

  async recall(data, message_id) {
    Bot.makeLog("info", `撤回消息：${message_id}`, data.self_id)
    if (!Array.isArray(message_id)) message_id = [message_id]
    const msgs = []
    for (const i of message_id)
      msgs.push(await data.bot.callApi("delete_msg", { message_id: i }).catch(i => i))
    return msgs
  }

  /** OneBot 消息段数组转本体段数组 */
  normalizeSegments(msg) {
    const array = []
    for (const i of Array.isArray(msg) ? msg : [msg])
      if (typeof i === "object") array.push({ ...i.data, type: i.type })
      else array.push({ type: "text", text: String(i) })
    return array
  }

  async getMessage(data, message_id) {
    const msg = (await data.bot.callApi("get_msg", { message_id })).data
    if (msg?.message) msg.message = this.normalizeSegments(msg.message)
    return msg
  }

  async getFriendHistory(data, message_seq, count, reverseOrder = true) {
    const msgs = (
      await data.bot.callApi(
        "get_friend_msg_history",
        {
          user_id: data.user_id,
          message_seq,
          count,
          reverseOrder,
        },
        300000,
      )
    ).data?.messages

    for (const i of Array.isArray(msgs) ? msgs : [msgs])
      if (i?.message) i.message = this.normalizeSegments(i.message)
    return msgs
  }

  async getGroupHistory(data, message_seq, count, reverseOrder = true) {
    const msgs = (
      await data.bot.callApi(
        "get_group_msg_history",
        {
          group_id: data.group_id,
          message_seq,
          count,
          reverseOrder,
        },
        300000,
      )
    ).data?.messages

    for (const i of Array.isArray(msgs) ? msgs : [msgs])
      if (i?.message) i.message = this.normalizeSegments(i.message)
    return msgs
  }

  async getForwardMsg(data, message_id) {
    const msgs = (
      await data.bot.callApi(
        "get_forward_msg",
        {
          message_id,
        },
        300000,
      )
    ).data?.messages

    for (const i of Array.isArray(msgs) ? msgs : [msgs])
      if (i?.message) i.message = this.normalizeSegments(i.message || i.content)
    return msgs
  }

  async buildForwardNodes(msg) {
    const nodes = []
    for (const i of msg) {
      /** 转发节点内保留 file 段：剥离会导致整段文件丢失，只含文件的节点还会整条消失 */
      const { segments, nodes: subNodes } = await this.buildMessage(i.message, false)
      if (subNodes.length) nodes.push(...(await this.buildForwardNodes(subNodes)))
      if (segments.length)
        nodes.push({
          type: "node",
          data: {
            name: i.nickname || "匿名消息",
            uin: String(Number(i.user_id) || 80000000),
            content: segments,
            time: i.time,
          },
        })
    }
    return nodes
  }

  async sendFriendForward(data, msg) {
    Bot.makeLog(
      "info",
      `发送好友转发消息：${this.textOf(msg)}`,
      `${data.self_id} => ${data.user_id}`,
      true,
    )
    return data.bot.callApi("send_private_forward_msg", {
      user_id: data.user_id,
      messages: await this.buildForwardNodes(msg),
    })
  }

  async sendGroupForward(data, msg) {
    Bot.makeLog(
      "info",
      `发送群转发消息：${this.textOf(msg)}`,
      `${data.self_id} => ${data.group_id}`,
      true,
    )
    return data.bot.callApi("send_group_forward_msg", {
      group_id: data.group_id,
      messages: await this.buildForwardNodes(msg),
    })
  }

  /* ==== 好友 / 群 / 成员 列表与信息 ==== */

  async fetchFriendList(data) {
    return (await data.bot.callApi("get_friend_list")).data || []
  }

  async friendIds(data) {
    const ids = []
    for (const { user_id } of await this.fetchFriendList(data)) ids.push(user_id)
    return ids
  }

  async friendMap(data) {
    const map = new Map()
    for (const i of await this.fetchFriendList(data)) map.set(i.user_id, i)
    data.bot.fl = map
    return map
  }

  async strangerInfo(data, no_cache, add) {
    const info = (
      await data.bot.callApi("get_stranger_info", {
        user_id: data.user_id,
        no_cache,
      })
    ).data
    if (add || data.bot.fl.has(data.user_id)) data.bot.fl.set(data.user_id, info)
    return info
  }

  async fetchGroupList(data) {
    const list = (await data.bot.callApi("get_group_list")).data
    try {
      /* 频道归属的群合并进列表：频道数据形如 guild-channel 组合键 */
      for (const guild of await this.guilds(data))
        for (const channel of await this.guildChannels({
          ...data,
          guild_id: guild.guild_id,
        }))
          list.push({
            guild,
            channel,
            group_id: `${guild.guild_id}-${channel.channel_id}`,
            group_name: `${guild.guild_name}-${channel.channel_name}`,
          })
    } catch (err) {
      /* 频道接口不可用时忽略，仅返回普通群列表 */
    }
    return list
  }

  async groupIds(data) {
    const ids = []
    for (const { group_id } of await this.fetchGroupList(data)) ids.push(group_id)
    return ids
  }

  async groupMap(data) {
    const map = new Map()
    for (const i of await this.fetchGroupList(data)) map.set(i.group_id, i)
    data.bot.gl = map
    return map
  }

  async groupInfo(data, no_cache, add) {
    const info = (
      await data.bot.callApi("get_group_info", {
        group_id: data.group_id,
        no_cache,
      })
    ).data
    if (add || data.bot.gl.has(data.group_id)) data.bot.gl.set(data.group_id, info)
    return info
  }

  async memberList(data) {
    return (
      (
        await data.bot.callApi("get_group_member_list", {
          group_id: data.group_id,
        })
      ).data || []
    )
  }

  async memberIds(data) {
    const ids = []
    for (const { user_id } of await this.memberList(data)) ids.push(user_id)
    return ids
  }

  async memberMap(data) {
    const map = new Map()
    for (const i of await this.memberList(data)) map.set(i.user_id, i)
    data.bot.gml.set(data.group_id, map)
    return map
  }

  async allMemberMaps(data) {
    if (!cfg.bot.cache_group_member) return this.groupMap(data)
    for (const [group_id, group] of await this.groupMap(data)) {
      if (group.guild) continue
      await this.memberMap({ ...data, group_id })
    }
  }

  async memberInfo(data, no_cache, add) {
    const info = (
      await data.bot.callApi("get_group_member_info", {
        group_id: data.group_id,
        user_id: data.user_id,
        no_cache,
      })
    ).data
    let gml = data.bot.gml.get(data.group_id)
    if (!gml) {
      gml = new Map()
      if (add || data.bot.gl.has(data.group_id)) data.bot.gml.set(data.group_id, gml)
    }
    if (add || data.bot.gml.has(data.user_id)) gml.set(data.user_id, info)
    return info
  }

  /* ==== 频道 ==== */

  async guilds(data) {
    return (await data.bot.callApi("get_guild_list")).data || []
  }

  guildInfo(data) {
    return data.bot.callApi("get_guild_meta_by_guest", {
      guild_id: data.guild_id,
    })
  }

  async guildChannels(data) {
    return (
      (
        await data.bot.callApi("get_guild_channel_list", {
          guild_id: data.guild_id,
        })
      ).data || []
    )
  }

  async guildChannelMap(data) {
    const map = new Map()
    for (const i of await this.guildChannels(data)) map.set(i.channel_id, i)
    return map
  }

  async guildChannelIds(data) {
    const ids = []
    for (const { channel_id } of await this.guildChannels(data)) ids.push(channel_id)
    return ids
  }

  async guildMembers(data) {
    const members = []
    let next_token = ""
    while (true) {
      const page = (
        await data.bot.callApi("get_guild_member_list", {
          guild_id: data.guild_id,
          next_token,
        })
      ).data
      if (!page) break

      for (const i of page.members)
        members.push({
          ...i,
          user_id: i.tiny_id,
        })
      if (page.finished) break
      next_token = page.next_token
    }
    return members
  }

  async guildMemberMap(data) {
    const map = new Map()
    for (const i of await this.guildMembers(data)) map.set(i.user_id, i)
    data.bot.gml.set(data.group_id, map)
    return map
  }

  async guildMemberIds(data) {
    const ids = []
    for (const { user_id } of await this.guildMembers(data)) ids.push(user_id)
    return ids
  }

  guildMemberInfo(data) {
    return data.bot.callApi("get_guild_member_profile", {
      guild_id: data.guild_id,
      user_id: data.user_id,
    })
  }

  /* ==== 资料与群管理 ==== */

  setProfile(data, profile) {
    Bot.makeLog("info", `设置资料：${Bot.String(profile)}`, data.self_id)
    return data.bot.callApi("set_qq_profile", profile)
  }

  async setAvatar(data, file) {
    Bot.makeLog("info", `设置头像：${file}`, data.self_id)
    return data.bot.callApi("set_qq_avatar", {
      file: await this.toFileTarget(file),
    })
  }

  sendLike(data, times) {
    Bot.makeLog("info", `点赞：${times}次`, `${data.self_id} => ${data.user_id}`, true)
    return data.bot.callApi("send_like", {
      user_id: data.user_id,
      times,
    })
  }

  setGroupName(data, group_name) {
    Bot.makeLog("info", `设置群名：${group_name}`, `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("set_group_name", {
      group_id: data.group_id,
      group_name,
    })
  }

  async setGroupAvatar(data, file) {
    Bot.makeLog("info", `设置群头像：${file}`, `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("set_group_portrait", {
      group_id: data.group_id,
      file: await this.toFileTarget(file),
    })
  }

  setGroupAdmin(data, user_id, enable) {
    Bot.makeLog(
      "info",
      `${enable ? "设置" : "取消"}群管理员：${user_id}`,
      `${data.self_id} => ${data.group_id}`,
      true,
    )
    return data.bot.callApi("set_group_admin", {
      group_id: data.group_id,
      user_id,
      enable,
    })
  }

  setGroupCard(data, user_id, card) {
    Bot.makeLog("info", `设置群名片：${card}`, `${data.self_id} => ${data.group_id}, ${user_id}`, true)
    return data.bot.callApi("set_group_card", {
      group_id: data.group_id,
      user_id,
      card,
    })
  }

  setGroupTitle(data, user_id, special_title, duration) {
    Bot.makeLog(
      "info",
      `设置群头衔：${special_title} ${duration}`,
      `${data.self_id} => ${data.group_id}, ${user_id}`,
      true,
    )
    return data.bot.callApi("set_group_special_title", {
      group_id: data.group_id,
      user_id,
      special_title,
      duration,
    })
  }

  sendGroupSign(data) {
    Bot.makeLog("info", "群打卡", `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("send_group_sign", {
      group_id: data.group_id,
    })
  }

  banMember(data, user_id, duration) {
    Bot.makeLog(
      "info",
      `禁言群成员：${duration}秒`,
      `${data.self_id} => ${data.group_id}, ${user_id}`,
      true,
    )
    return data.bot.callApi("set_group_ban", {
      group_id: data.group_id,
      user_id,
      duration,
    })
  }

  banAll(data, enable) {
    Bot.makeLog("info", `${enable ? "开启" : "关闭"}全员禁言`, `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("set_group_whole_ban", {
      group_id: data.group_id,
      enable,
    })
  }

  kickMember(data, user_id, reject_add_request) {
    Bot.makeLog(
      "info",
      `踢出群成员${reject_add_request ? "拒绝再次加群" : ""}`,
      `${data.self_id} => ${data.group_id}, ${user_id}`,
      true,
    )
    return data.bot.callApi("set_group_kick", {
      group_id: data.group_id,
      user_id,
      reject_add_request,
    })
  }

  leaveGroup(data, is_dismiss) {
    Bot.makeLog("info", is_dismiss ? "解散" : "退群", `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("set_group_leave", {
      group_id: data.group_id,
      is_dismiss,
    })
  }

  async sendGroupNotice(data, content, opts = {}) {
    Bot.makeLog("info", [`发送群公告：${content}`, opts], `${data.self_id} => ${data.group_id}`, true)
    if (opts.image) opts.image = await this.toFileTarget(opts.image)
    return data.bot.callApi("_send_group_notice", {
      group_id: data.group_id,
      content,
      ...opts,
    })
  }

  getGroupNotice(data) {
    Bot.makeLog("info", "获取群公告", `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("_get_group_notice", {
      group_id: data.group_id,
    })
  }

  /* ==== 群文件 ==== */

  downloadFile(data, url, thread_count, headers) {
    return data.bot.callApi("download_file", {
      url,
      thread_count,
      headers,
    })
  }

  async sendFriendFile(data, file, name = path.basename(file)) {
    Bot.makeLog(
      "info",
      `发送好友文件：${name}(${file})`,
      `${data.self_id} => ${data.user_id}`,
      true,
    )
    return data.bot.callApi("upload_private_file", {
      user_id: data.user_id,
      file: (await this.toFileTarget(file, { file: true })).replace("file://", ""),
      name,
    })
  }

  async getPrivateFileUrl(data, file_id) {
    return (
      await data.bot.callApi("get_private_file_url", {
        user_id: data.user_id,
        file_id,
      })
    ).url
  }

  async sendGroupFile(data, file, folder, name = path.basename(file)) {
    Bot.makeLog(
      "info",
      `发送群文件：${folder || ""}/${name}(${file})`,
      `${data.self_id} => ${data.group_id}`,
      true,
    )
    return data.bot.callApi("upload_group_file", {
      group_id: data.group_id,
      folder,
      file: (await this.toFileTarget(file, { file: true })).replace("file://", ""),
      name,
    })
  }

  deleteGroupFile(data, file_id, busid) {
    Bot.makeLog("info", `删除群文件：${file_id}(${busid})`, `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("delete_group_file", {
      group_id: data.group_id,
      file_id,
      busid,
    })
  }

  createGroupFileFolder(data, name) {
    Bot.makeLog("info", `创建群文件夹：${name}`, `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("create_group_file_folder", {
      group_id: data.group_id,
      name,
    })
  }

  groupFileSystemInfo(data) {
    return data.bot.callApi("get_group_file_system_info", {
      group_id: data.group_id,
    })
  }

  groupFiles(data, folder_id) {
    if (folder_id)
      return data.bot.callApi("get_group_files_by_folder", {
        group_id: data.group_id,
        folder_id,
      })
    return data.bot.callApi("get_group_root_files", {
      group_id: data.group_id,
    })
  }

  groupFileUrl(data, file_id, busid) {
    return data.bot.callApi("get_group_file_url", {
      group_id: data.group_id,
      file_id,
      busid,
    })
  }

  groupFs(data) {
    return {
      upload: this.sendGroupFile.bind(this, data),
      rm: this.deleteGroupFile.bind(this, data),
      mkdir: this.createGroupFileFolder.bind(this, data),
      df: this.groupFileSystemInfo.bind(this, data),
      ls: this.groupFiles.bind(this, data),
      download: this.groupFileUrl.bind(this, data),
    }
  }

  deleteFriend(data) {
    Bot.makeLog("info", "删除好友", `${data.self_id} => ${data.user_id}`, true)
    return data.bot.callApi("delete_friend", { user_id: data.user_id }).finally(this.friendMap.bind(this, data))
  }

  setFriendAddRequest(data, flag, approve, remark) {
    return data.bot.callApi("set_friend_add_request", {
      flag,
      approve,
      remark,
    })
  }

  setGroupAddRequest(data, flag, approve, reason, sub_type = "add") {
    return data.bot.callApi("set_group_add_request", {
      flag,
      sub_type,
      approve,
      reason,
    })
  }

  groupHonorInfo(data) {
    return data.bot.callApi("get_group_honor_info", { group_id: data.group_id })
  }

  essenceMsgs(data) {
    return data.bot.callApi("get_essence_msg_list", { group_id: data.group_id })
  }

  addEssenceMsg(data, message_id) {
    return data.bot.callApi("set_essence_msg", { message_id })
  }

  removeEssenceMsg(data, message_id) {
    return data.bot.callApi("delete_essence_msg", { message_id })
  }

  async todoList(data) {
    Bot.makeLog("info", "获取群待办列表", `${data.self_id} => ${data.group_id}`, true)
    const list =
      (await data.bot.callApi("get_group_todo_list", { group_id: data.group_id })).data || []
    for (const i of list) if (i?.message) i.message = this.normalizeSegments(i.message)
    return list
  }

  setTodo(data, message_id) {
    Bot.makeLog("info", `设置群待办：${message_id}`, `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("set_group_todo", {
      group_id: data.group_id,
      message_id,
    })
  }

  completeTodo(data, message_id) {
    Bot.makeLog("info", `完成群待办：${message_id}`, `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("complete_group_todo", {
      group_id: data.group_id,
      message_id,
    })
  }

  cancelTodo(data, message_id) {
    Bot.makeLog("info", `取消群待办：${message_id}`, `${data.self_id} => ${data.group_id}`, true)
    return data.bot.callApi("cancel_group_todo", {
      group_id: data.group_id,
      message_id,
    })
  }

  /* ==== 对象封装 ==== */

  /** 好友对象：合并缓存信息与事件上下文 */
  pickFriend(data, user_id) {
    const target = {
      ...data.bot.fl.get(user_id),
      ...data,
      user_id,
    }
    return {
      ...target,
      sendMsg: this.sendToFriend.bind(this, target),
      getMsg: this.getMessage.bind(this, target),
      recallMsg: this.recall.bind(this, target),
      getForwardMsg: this.getForwardMsg.bind(this, target),
      sendForwardMsg: this.sendFriendForward.bind(this, target),
      sendFile: this.sendFriendFile.bind(this, target),
      getInfo: this.strangerInfo.bind(this, target),
      getAvatarUrl() {
        return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
      },
      getChatHistory: this.getFriendHistory.bind(this, target),
      thumbUp: this.sendLike.bind(this, target),
      delete: this.deleteFriend.bind(this, target),
      getFileUrl: this.getPrivateFileUrl.bind(this, target),
    }
  }

  /** 群成员对象：频道成员走 guild 分支，普通成员继承好友对象能力 */
  pickMember(data, group_id, user_id) {
    if (typeof group_id === "string" && group_id.match("-")) {
      const [guild_id, channel_id] = group_id.split("-")
      const target = {
        ...data,
        guild_id,
        channel_id,
        user_id,
      }
      return {
        ...this.pickGroup(target, group_id),
        ...target,
        getInfo: this.guildMemberInfo.bind(this, target),
        getAvatarUrl: async () => (await this.guildMemberInfo(target)).avatar_url,
      }
    }

    const target = {
      ...data.bot.gml.get(group_id)?.get(user_id),
      ...data,
      group_id,
      user_id,
    }
    return {
      ...this.pickFriend(target, user_id),
      ...target,
      getInfo: this.memberInfo.bind(this, target),
      getAvatarUrl() {
        return this.avatar || `https://q.qlogo.cn/g?b=qq&s=0&nk=${user_id}`
      },
      poke: this.sendToGroup.bind(this, target, { type: "poke", qq: user_id }),
      mute: this.banMember.bind(this, target, user_id),
      kick: this.kickMember.bind(this, target, user_id),
      get is_friend() {
        return data.bot.fl.has(user_id)
      },
      get is_owner() {
        return this.role === "owner"
      },
      get is_admin() {
        return this.role === "admin" || this.is_owner
      },
    }
  }

  /** 群对象：频道群走 guild 分支 */
  pickGroup(data, group_id) {
    if (typeof group_id === "string" && group_id.match("-")) {
      const [guild_id, channel_id] = group_id.split("-")
      const target = {
        ...data.bot.gl.get(group_id),
        ...data,
        guild_id,
        channel_id,
      }
      return {
        ...target,
        sendMsg: this.sendToGuild.bind(this, target),
        getMsg: this.getMessage.bind(this, target),
        recallMsg: this.recall.bind(this, target),
        getForwardMsg: this.getForwardMsg.bind(this, target),
        getInfo: this.guildInfo.bind(this, target),
        getChannelArray: this.guildChannels.bind(this, target),
        getChannelList: this.guildChannelIds.bind(this, target),
        getChannelMap: this.guildChannelMap.bind(this, target),
        getMemberArray: this.guildMembers.bind(this, target),
        getMemberList: this.guildMemberIds.bind(this, target),
        getMemberMap: this.guildMemberMap.bind(this, target),
        pickMember: this.pickMember.bind(this, target),
      }
    }

    const target = {
      ...data.bot.gl.get(group_id),
      ...data,
      group_id,
    }
    return {
      ...target,
      sendMsg: this.sendToGroup.bind(this, target),
      getMsg: this.getMessage.bind(this, target),
      recallMsg: this.recall.bind(this, target),
      getForwardMsg: this.getForwardMsg.bind(this, target),
      sendForwardMsg: this.sendGroupForward.bind(this, target),
      sendFile: (file, name) => this.sendGroupFile(target, file, undefined, name),
      getFileUrl: (file_id, busid) => this.groupFileUrl(target, file_id, busid),
      getInfo: this.groupInfo.bind(this, target),
      getAvatarUrl() {
        return this.avatar || `https://p.qlogo.cn/gh/${group_id}/${group_id}/0`
      },
      getChatHistory: this.getGroupHistory.bind(this, target),
      getHonorInfo: this.groupHonorInfo.bind(this, target),
      getEssence: this.essenceMsgs.bind(this, target),
      getTodoList: this.todoList.bind(this, target),
      setTodo: this.setTodo.bind(this, target),
      completeTodo: this.completeTodo.bind(this, target),
      cancelTodo: this.cancelTodo.bind(this, target),
      getMemberArray: this.memberList.bind(this, target),
      getMemberList: this.memberIds.bind(this, target),
      getMemberMap: this.memberMap.bind(this, target),
      pickMember: this.pickMember.bind(this, target, group_id),
      pokeMember: qq => this.sendToGroup(target, { type: "poke", qq }),
      setName: this.setGroupName.bind(this, target),
      setAvatar: this.setGroupAvatar.bind(this, target),
      setAdmin: this.setGroupAdmin.bind(this, target),
      setCard: this.setGroupCard.bind(this, target),
      setTitle: this.setGroupTitle.bind(this, target),
      sign: this.sendGroupSign.bind(this, target),
      muteMember: this.banMember.bind(this, target),
      muteAll: this.banAll.bind(this, target),
      kickMember: this.kickMember.bind(this, target),
      quit: this.leaveGroup.bind(this, target),
      get announce() {
        return this.sendNotice
      },
      sendNotice: this.sendGroupNotice.bind(this, target),
      getNotice: this.getGroupNotice.bind(this, target),
      fs: this.groupFs(target),
      get is_owner() {
        return data.bot.gml.get(group_id)?.get(data.self_id)?.role === "owner"
      },
      get is_admin() {
        return data.bot.gml.get(group_id)?.get(data.self_id)?.role === "admin" || this.is_owner
      },
    }
  }

  /* ==== 注册与事件派发 ==== */

  /**
   * 连接建立：创建 Bot 账号对象并拉取基础资料
   */
  async registerBot(data, ws) {
    Bot[data.self_id] = {
      adapter: this,
      ws,
      /** openapi 调用入口，两个名字指向同一实现 */
      sendApi: this.callApi.bind(this, data, ws),
      callApi: this.callApi.bind(this, data, ws),
      stat: {
        start_time: data.time,
        stat: {},
        get lost_pkt_cnt() {
          return this.stat.packet_lost
        },
        get lost_times() {
          return this.stat.lost_times
        },
        get recv_msg_cnt() {
          return this.stat.message_received
        },
        get recv_pkt_cnt() {
          return this.stat.packet_received
        },
        get sent_msg_cnt() {
          return this.stat.message_sent
        },
        get sent_pkt_cnt() {
          return this.stat.packet_sent
        },
      },
      model: "FMCYz",

      info: {},
      get uin() {
        return this.info.user_id
      },
      get nickname() {
        return this.info.nickname
      },
      get avatar() {
        return `https://q.qlogo.cn/g?b=qq&s=0&nk=${this.uin}`
      },

      setProfile: this.setProfile.bind(this, data),
      setNickname: nickname => this.setProfile(data, { nickname }),
      setAvatar: this.setAvatar.bind(this, data),

      pickFriend: this.pickFriend.bind(this, data),
      get pickUser() {
        return this.pickFriend
      },
      getFriendArray: this.fetchFriendList.bind(this, data),
      getFriendList: this.friendIds.bind(this, data),
      getFriendMap: this.friendMap.bind(this, data),
      fl: new Map(),

      pickMember: this.pickMember.bind(this, data),
      getGroupMemberInfo(group_id, user_id) {
        return this.pickMember(group_id, user_id)?.getInfo(true, true)
      },
      pickGroup: this.pickGroup.bind(this, data),
      getGroupArray: this.fetchGroupList.bind(this, data),
      getGroupList: this.groupIds.bind(this, data),
      getGroupMap: this.groupMap.bind(this, data),
      getGroupMemberMap: this.allMemberMaps.bind(this, data),
      gl: new Map(),
      gml: new Map(),

      request_list: [],
      getSystemMsg() {
        return this.request_list
      },
      setFriendAddRequest: this.setFriendAddRequest.bind(this, data),
      setGroupAddRequest: this.setGroupAddRequest.bind(this, data),

      setEssenceMessage: this.addEssenceMsg.bind(this, data),
      removeEssenceMessage: this.removeEssenceMsg.bind(this, data),

      cookies: {},
      getCookies(domain) {
        return this.cookies[domain]
      },
      getCsrfToken() {
        return this.bkn
      },
    }
    data.bot = Bot[data.self_id]

    if (!Bot.uins.includes(data.self_id)) Bot.uins.push(data.self_id)

    /* 型号展示，失败不影响连接 */
    data.bot.callApi("_set_model_show", {
      model: data.bot.model,
      model_show: data.bot.model,
    }).catch(() => {})

    /* 拉取账号资料与 cookie */
    data.bot.info = (await data.bot.callApi("get_login_info").catch(() => ({}))).data
    data.bot.guild_info = (
      await data.bot.callApi("get_guild_service_profile").catch(() => ({}))
    ).data
    data.bot.clients = (await data.bot.callApi("get_online_clients").catch(() => ({}))).clients
    data.bot.version = {
      ...(await data.bot.callApi("get_version_info").catch(() => ({}))).data,
      id: this.id,
      name: this.name,
      get version() {
        return this.app_full_name || `${this.app_name} v${this.app_version}`
      },
    }

    data.bot.cookies["qun.qq.com"] = (
      await data.bot.callApi("get_cookies", { domain: "qun.qq.com" }).catch(() => ({}))
    ).cookies
    for (const domain of [
      "aq", "connect", "docs", "game", "gamecenter", "haoma", "id", "kg", "mail", "mma",
      "office", "openmobile", "qqweb", "qzone", "ti", "v", "vip", "y",
    ]) {
      data.bot.cookies[`${domain}.qq.com`] = await data.bot
        .callApi("get_cookies", { domain })
        .then(i => i.cookies)
        .catch(() => undefined)
    }
    data.bot.bkn = (await data.bot.callApi("get_csrf_token").catch(() => ({}))).token

    data.bot.getFriendMap()
    data.bot.getGroupMemberMap()

    Bot.makeLog("mark", `${this.name}(${this.id}) 已连接`, data.self_id)
    Bot.em(`connect.${data.self_id}`, data)
  }

  /** 消息事件：段归一化后按消息来源记录日志并组装兼容字段 */
  dispatchMessage(data) {
    /* OneBot 段 { type, data } 转本体段，供 loader 与插件直接消费 */
    data.message = this.normalizeSegments(data.message)

    switch (data.message_type) {
      case "private": {
        const name =
          data.sender.card || data.sender.nickname || data.bot.fl.get(data.user_id)?.nickname
        Bot.makeLog(
          "info",
          `好友消息：${name ? `[${name}] ` : ""}${data.raw_message}`,
          `${data.self_id} <= ${data.user_id}`,
          true,
        )
        break
      }
      case "group": {
        const group_name = data.group_name || data.bot.gl.get(data.group_id)?.group_name
        let user_name = data.sender.card || data.sender.nickname
        if (!user_name) {
          const user =
            data.bot.gml.get(data.group_id)?.get(data.user_id) || data.bot.fl.get(data.user_id)
          if (user) user_name = user?.card || user?.nickname
        }
        Bot.makeLog(
          "info",
          `群消息：${user_name ? `[${group_name ? `${group_name}, ` : ""}${user_name}] ` : ""}${data.raw_message}`,
          `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
          true,
        )
        break
      }
      case "guild":
        data.message_type = "group"
        data.group_id = `${data.guild_id}-${data.channel_id}`
        Bot.makeLog(
          "info",
          `频道消息：[${data.sender.nickname}] ${Bot.String(data.message)}`,
          `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
          true,
        )
        Object.defineProperty(data, "friend", {
          get() {
            return this.member || {}
          },
        })
        break
      default:
        Bot.makeLog("warn", `未知消息：${Bot.String(data.raw)}`, data.self_id)
    }

    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  /** 通知事件处理器表：notice_type → 处理函数 */
  noticeHandlers = {
    friend_recall(data) {
      Bot.makeLog("info", `好友消息撤回：${data.message_id}`, `${data.self_id} <= ${data.user_id}`, true)
    },
    group_recall(data) {
      Bot.makeLog(
        "info",
        `群消息撤回：${data.operator_id} => ${data.user_id} ${data.message_id}`,
        `${data.self_id} <= ${data.group_id}`,
        true,
      )
    },
    async group_increase(data) {
      Bot.makeLog(
        "info",
        `群成员增加：${data.operator_id} => ${data.user_id} ${data.sub_type}`,
        `${data.self_id} <= ${data.group_id}`,
        true,
      )
      const group = data.bot.pickGroup(data.group_id)
      group.getInfo(true, true)
      if (data.user_id === data.self_id && cfg.bot.cache_group_member) group.getMemberMap()
      else group.pickMember(data.user_id).getInfo(true, true)
    },
    async group_decrease(data) {
      Bot.makeLog(
        "info",
        `群成员减少：${data.operator_id} => ${data.user_id} ${data.sub_type}`,
        `${data.self_id} <= ${data.group_id}`,
        true,
      )
      if (data.user_id === data.self_id) {
        data.bot.gl.delete(data.group_id)
        data.bot.gml.delete(data.group_id)
      } else {
        data.bot.pickGroup(data.group_id).getInfo(true, true)
        data.bot.gml.get(data.group_id)?.delete(data.user_id)
      }
    },
    group_admin(data) {
      Bot.makeLog(
        "info",
        `群管理员变动：${data.sub_type}`,
        `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
        true,
      )
      data.set = data.sub_type === "set"
      data.bot.pickMember(data.group_id, data.user_id).getInfo(true, true)
    },
    group_upload(data) {
      Bot.makeLog("info", `群文件上传：${Bot.String(data.file)}`, `${data.self_id} <= ${data.group_id}`, true)
      Bot.em("message.group.normal", {
        ...data,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message: [{ ...data.file, type: "file" }],
        raw_message: `[文件：${data.file.name}]`,
      })
    },
    group_ban(data) {
      Bot.makeLog(
        "info",
        `群禁言：${data.operator_id} => ${data.user_id} ${data.sub_type} ${data.duration}秒`,
        `${data.self_id} <= ${data.group_id}`,
        true,
      )
      if (data.user_id !== 0)
        data.bot.pickMember(data.group_id, data.user_id).getInfo(true, true)
    },
    group_msg_emoji_like(data) {
      Bot.makeLog(
        "info",
        [`群消息回应：${data.message_id}`, data.likes],
        `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
        true,
      )
    },
    async friend_add(data) {
      Bot.makeLog("info", "好友添加", `${data.self_id} <= ${data.user_id}`, true)
      data.bot.pickFriend(data.user_id).getInfo(true, true)
    },
    /** 戳一戳等资料卡通知 */
    notify(data) {
      if (data.group_id) data.notice_type = "group"
      else data.notice_type = "friend"
      data.user_id ??= data.operator_id || data.target_id
      switch (data.sub_type) {
        case "poke":
          data.operator_id = data.user_id
          if (data.group_id)
            Bot.makeLog(
              "info",
              `群戳一戳：${data.operator_id} => ${data.target_id}`,
              `${data.self_id} <= ${data.group_id}`,
              true,
            )
          else
            Bot.makeLog("info", `好友戳一戳：${data.operator_id} => ${data.target_id}`, data.self_id)
          break
        case "poke_recall":
          data.operator_id = data.user_id
          if (data.group_id)
            Bot.makeLog(
              "info",
              `群戳一戳撤回：${data.operator_id} => ${data.target_id}`,
              `${data.self_id} <= ${data.group_id}`,
              true,
            )
          else
            Bot.makeLog("info", `好友戳一戳撤回：${data.operator_id} => ${data.target_id}`, data.self_id)
          break
        case "honor":
          Bot.makeLog("info", `群荣誉：${data.honor_type}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
          data.bot.pickMember(data.group_id, data.user_id).getInfo(true, true)
          break
        case "title":
          Bot.makeLog("info", `群头衔：${data.title}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true)
          data.bot.pickMember(data.group_id, data.user_id).getInfo(true, true)
          break
        case "group_name":
          Bot.makeLog("info", `群名更改：${data.name_new}`, `${data.self_id} <= ${data.group_id}`, true)
          data.bot.pickGroup(data.group_id).getInfo(true, true)
          break
        case "input_status":
          data.post_type = "internal"
          data.notice_type = "input"
          data.end ??= data.event_type !== 1
          data.message ||= data.status_text || `对方${data.end ? "结束" : "正在"}输入...`
          Bot.makeLog("info", data.message, `${data.self_id} <= ${data.user_id}`, true)
          break
        case "profile_like":
          Bot.makeLog("info", `资料卡点赞：${data.times}次`, `${data.self_id} <= ${data.operator_id}`, true)
          break
        default:
          Bot.makeLog("warn", `未知通知：${Bot.String(data.raw)}`, data.self_id)
      }
    },
    group_card(data) {
      Bot.makeLog(
        "info",
        `群名片更新：${data.card_old} => ${data.card_new}`,
        `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
        true,
      )
      data.bot.pickMember(data.group_id, data.user_id).getInfo(true, true)
    },
    offline_file(data) {
      Bot.makeLog("info", `离线文件：${Bot.String(data.file)}`, `${data.self_id} <= ${data.user_id}`, true)
      Bot.em("message.private.friend", {
        ...data,
        post_type: "message",
        message_type: "private",
        sub_type: "friend",
        message: [{ ...data.file, type: "file" }],
        raw_message: `[文件：${data.file.name}]`,
      })
    },
    async client_status(data) {
      Bot.makeLog("info", `客户端${data.online ? "上线" : "下线"}：${Bot.String(data.client)}`, data.self_id)
      data.clients = (await data.bot.callApi("get_online_clients")).clients
    },
    essence(data) {
      data.notice_type = "group_essence"
      Bot.makeLog(
        "info",
        `群精华消息：${data.operator_id} => ${data.sender_id} ${data.sub_type} ${data.message_id}`,
        `${data.self_id} <= ${data.group_id}`,
        true,
      )
    },
    guild_channel_recall(data) {
      data.notice_type = "guild_channel_recall"
      Bot.makeLog(
        "info",
        `频道消息撤回：${data.operator_id} => ${data.user_id} ${data.message_id}`,
        `${data.self_id} <= ${data.guild_id}-${data.channel_id}`,
        true,
      )
    },
    message_reactions_updated(data) {
      data.notice_type = "guild_message_reactions_updated"
      Bot.makeLog(
        "info",
        `频道消息表情贴：${data.message_id} ${Bot.String(data.current_reactions)}`,
        `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
        true,
      )
    },
    channel_updated(data) {
      data.notice_type = "guild_channel_updated"
      Bot.makeLog(
        "info",
        `子频道更新：${Bot.String(data.old_info)} => ${Bot.String(data.new_info)}`,
        `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
        true,
      )
    },
    channel_created(data) {
      data.notice_type = "guild_channel_created"
      Bot.makeLog(
        "info",
        `子频道创建：${Bot.String(data.channel_info)}`,
        `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
        true,
      )
      data.bot.getGroupMap()
    },
    channel_destroyed(data) {
      data.notice_type = "guild_channel_destroyed"
      Bot.makeLog(
        "info",
        `子频道删除：${Bot.String(data.channel_info)}`,
        `${data.self_id} <= ${data.guild_id}-${data.channel_id}, ${data.user_id}`,
        true,
      )
      data.bot.getGroupMap()
    },
    bot_offline(data) {
      data.post_type = "system"
      data.notice_type = "offline"
      Bot.makeLog("info", `${data.tag || "账号下线"}：${data.message}`, data.self_id)
      Bot.sendMasterMsg(`[${data.self_id}] ${data.tag || "账号下线"}：${data.message}`)
    },
  }

  /** 通知事件派发：查表处理，尾部统一做类型拆分与频道字段兼容 */
  dispatchNotice(data) {
    const handler = this.noticeHandlers[data.notice_type]
    if (handler) {
      try {
        handler.call(this, data)
      } catch (err) {
        logger.error(["OneBotv11 通知处理错误", data.notice_type, err])
      }
    } else {
      Bot.makeLog("warn", `未知通知：${Bot.String(data.raw)}`, data.self_id)
    }

    const parts = data.notice_type.split("_")
    data.notice_type = parts.shift()
    const sub = parts.join("_")
    if (sub) data.sub_type = sub

    if (data.guild_id && data.channel_id) {
      data.group_id = `${data.guild_id}-${data.channel_id}`
      Object.defineProperty(data, "friend", {
        get() {
          return this.member || {}
        },
      })
    }

    Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, data)
  }

  /** 请求事件（加好友/加群） */
  dispatchRequest(data) {
    switch (data.request_type) {
      case "friend":
        Bot.makeLog("info", `加好友请求：${data.comment}(${data.flag})`, `${data.self_id} <= ${data.user_id}`, true)
        data.sub_type = "add"
        data.approve = function (approve, remark) {
          return this.bot.setFriendAddRequest(this.flag, approve, remark)
        }
        break
      case "group":
        Bot.makeLog(
          "info",
          `加群请求：${data.sub_type} ${data.comment}(${data.flag})`,
          `${data.self_id} <= ${data.group_id}, ${data.user_id}`,
          true,
        )
        data.approve = function (approve, reason) {
          return this.bot.setGroupAddRequest(this.flag, approve, reason, this.sub_type)
        }
        break
      default:
        Bot.makeLog("warn", `未知请求：${Bot.String(data.raw)}`, data.self_id)
    }

    data.bot.request_list.push(data)
    Bot.em(`${data.post_type}.${data.request_type}.${data.sub_type}`, data)
  }

  /** 注册到 ws 服务端路由 */
  load() {
    if (!Array.isArray(Bot.wsf[this.path])) Bot.wsf[this.path] = []
    Bot.wsf[this.path].push((ws, ...args) =>
      ws.on("message", data => this.resolveApi(data, ws, ...args)),
    )
  }
}

Bot.adapter.push(new OneBotv11Adapter())
export { OneBotv11Adapter }
