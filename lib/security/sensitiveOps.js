import http from "node:http"
import cfg from "../config/config.js"

/**
 * 敏感插件操作门禁
 *
 * 机制：包装 http.Server.prototype.emit 的 "request" 事件，在请求进入各插件
 * 自建 HTTP 服务（如锅巴面板）之前统一拦截。路径匹配先做 URI 解码再统一转
 * 小写，消除 Express 路由大小写不敏感与插件鉴权正则大小写敏感之间的绕过空间。
 *
 * 命中安装/卸载插件类路径时，先向主人私聊发送确认请求，超时未确认则返回取消，
 * 确认通过后的一段时间窗口内（trustWindow）同来源操作免重复确认。
 * 门禁自身异常时放行原请求，不阻断 HTTP 服务。
 */

// 拦截的路径（小写形式；PUT/GET 不区分，避免方法差异漏拦）
const GATE_PATHS = ["/api/plugin/install", "/api/plugin/uninstall"]

// 与提示文案一致的确认时限
const CONFIRM_TIMEOUT = 120 * 1000

let trustUntil = 0
let pending = null

function readConf() {
  try {
    const def = cfg.getYaml?.("default_config", "security") || {}
    const user = cfg.getConfig?.("security") || {}
    return { ...def.sensitiveOps, ...user.sensitiveOps }
  } catch {
    return {}
  }
}

function normalizePath(rawUrl) {
  const raw = String(rawUrl || "").split("?")[0]
  try {
    return decodeURIComponent(raw).toLowerCase()
  } catch {
    return raw.toLowerCase()
  }
}

function isGated(path) {
  return GATE_PATHS.some(g => path === g || path.startsWith(g + "/"))
}

function sendJson(res, payload) {
  try {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(payload))
  } catch {}
}

function extractText(message) {
  if (typeof message === "string") return message.trim()
  if (Array.isArray(message)) {
    return message
      .filter(i => i?.type === "text" && i.text)
      .map(i => i.text.trim())
      .join("")
  }
  return ""
}

/**
 * 向主人私聊发送确认请求并等待回复
 * 只认 master 的私聊消息，群聊回复不作为确认凭证
 */
function requestConfirm(action, source) {
  const Bot = global.Bot
  if (!Bot?.sendMasterMsg || !Bot?.on) return Promise.resolve(false)

  const msg = [
    "⚠️ 操作安全提示",
    `来源：${source}`,
    `操作：${action}`,
    '回复"确认"执行，2 分钟内无回复自动取消',
  ].join("\n")
  try {
    Bot.sendMasterMsg(msg)
  } catch {}

  return new Promise(resolve => {
    const listener = data => {
      if (data?.message_type !== "private") return
      if (!cfg.masterQQ?.includes(String(data.user_id))) return
      if (extractText(data.message) !== "确认") return
      cleanup()
      resolve(true)
    }
    const cleanup = () => {
      clearTimeout(timer)
      try {
        Bot.off("message", listener)
      } catch {}
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, CONFIRM_TIMEOUT)
    Bot.on("message", listener)
  })
}

export function installSensitiveOps() {
  const origEmit = http.Server.prototype.emit
  http.Server.prototype.emit = function (event, req, res, ...rest) {
    if (event !== "request" || !res) {
      return origEmit.call(this, event, req, res, ...rest)
    }
    try {
      const conf = readConf()
      if (conf.enable === false) return origEmit.call(this, event, req, res, ...rest)

      const path = normalizePath(req?.url)
      if (!isGated(path)) return origEmit.call(this, event, req, res, ...rest)

      // 信任窗口内免重复确认
      if (Date.now() < trustUntil) return origEmit.call(this, event, req, res, ...rest)

      // 已有待确认操作时，后续同类请求直接取消，避免堆积多个等待
      if (pending) {
        sendJson(res, { status: 1, msg: "操作已取消：已有待确认的敏感操作" })
        return true
      }

      const action = path.includes("/uninstall") ? "卸载插件" : "安装插件"
      const source = `${req.socket?.remoteAddress || "未知来源"}（HTTP 请求）`

      pending = requestConfirm(action, source).then(ok => {
        pending = null
        if (ok) {
          trustUntil = Date.now() + (Number(conf.trustWindow) || 600) * 1000
          origEmit.call(this, event, req, res, ...rest)
        } else {
          sendJson(res, { status: 1, msg: "操作已取消：未获得主人确认" })
        }
      })
      return true
    } catch (err) {
      try {
        global.logger?.error("[操作门禁]", err)
      } catch {}
      return origEmit.call(this, event, req, res, ...rest)
    }
  }
}
