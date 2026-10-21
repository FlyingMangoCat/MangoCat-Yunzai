import express from "express"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import cfg from "../config/config.js"
import {
  isInitialized,
  setPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  tokenFromRequest,
  loginLocked,
  recordFail,
  clearFail,
} from "./auth.js"
import * as monitor from "./monitor.js"
import { sources, readConfig, writeConfig, readGroups, writeGroup, writeGroupDefault } from "./configStore.js"
import { requestConfirm } from "../security/sensitiveOps.js"
import { getLedger } from "./ledger.js"
import * as plugins from "./plugins.js"
import { listLogs, readLogs } from "./logs.js"
import * as help from "./help.js"

/**
 * 面板路由
 *
 * 挂在 Bot.express 的 /panel 下（本体 25527 端口），登录态为面板自签 JWT：
 * /panel/api/public、/panel/api/setup、/panel/api/login 免登录，其余接口全部校验。
 * 静态页面由同目录 public/ 提供，接口只做参数校验与调度，具体实现分散在
 * auth / monitor / configStore / ledger / plugins / logs / help 各模块。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, "public")

function panelConf() {
  const def = cfg.getdefSet?.("panel")?.panel || {}
  const user = cfg.getConfig?.("panel")?.panel || {}
  return {
    ...def,
    ...user,
    ledger: { ...(def.ledger || {}), ...(user.ledger || {}) },
    install: { ...(def.install || {}), ...(user.install || {}) },
  }
}

function ok(res, data = {}) {
  res.json({ ok: true, ...data })
}

function fail(res, code, message) {
  res.status(code).json({ ok: false, message })
}

function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      const message = String(err?.message || err)
      const code = /取消|白名单|台账|风险确认|已存在|不存在|不合法|不支持/.test(message) ? 400 : 500
      if (code === 500) global.logger?.error?.("[面板] 请求处理失败", err)
      fail(res, code, message)
    })
  }
}

function requireAuth(req, res, next) {
  const payload = verifyToken(tokenFromRequest(req))
  if (!payload) return fail(res, 401, "登录态无效或已过期")
  req.panelAuth = payload
  next()
}

// 与 fsGuard 的 KEY_CONFIG_FIELDS 一致：这些字段决定谁能以主人身份控制本体
const KEY_SECURITY_FIELDS = new Set(["masterQQ", "whiteGroup", "blackGroup", "blackQQ"])

/** 关键权限字段改动需主人私聊确认，避免面板密码泄露直接被改成攻击者的号 */
async function confirmKeyFields(fileKey, patches) {
  if (!Array.isArray(patches) || !patches.length) return
  const hits = patches.filter((patch) => KEY_SECURITY_FIELDS.has(String(patch?.path?.at?.(-1) ?? "")))
  if (!hits.length) return
  if (global.Bot?.stat?.online !== 2) throw new Error("操作已取消：本体未在线，无法完成确认")
  const names = hits.map((patch) => patch.path.join(".")).join("、")
  const ok = await requestConfirm(`修改关键权限配置 ${names}`, `面板配置写入（${fileKey}）`)
  if (!ok) throw new Error("操作已取消：未获得主人私聊确认")
}

let initialized = false
let streamBound = false

/**
 * 会员信息只读插件在本地落盘的缓存，不请求会员服务端：
 * 面板不承担会员校验职责，只是把插件已经拿到的状态展示出来；文件不存在时返回 null。
 */
function readMember() {
  const file = path.resolve("data", "guessrank", "member.json")
  if (!fs.existsSync(file)) return null
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"))
    const raw = data.expiresAt || data.expiry || data.expire || null
    const num = typeof raw === "number" && raw < 1e12 ? raw * 1000 : raw
    const expire = raw ? new Date(num) : null
    const valid = expire && !Number.isNaN(expire.getTime())
    const remainingDays = valid ? Math.max(0, Math.ceil((expire.getTime() - Date.now()) / 86400000)) : null
    return {
      active: data.isActive === true || (remainingDays !== null && remainingDays > 0),
      expire: valid ? expire.toISOString() : null,
      remainingDays,
    }
  } catch {
    return null
  }
}

/** 首次请求时初始化：目录、采样器、消息计数、WebSocket 分发（此时 Bot 已就绪） */
function ensureInit() {
  if (initialized) return
  initialized = true
  fs.mkdirSync(path.join("data", "panel"), { recursive: true })
  monitor.start()
  const Bot = global.Bot
  if (Bot) monitor.bindBot(Bot)
  if (Bot?.wsf && !streamBound) {
    streamBound = true
    Bot.wsf["panel-stream"] = [panelStream]
  }
}

/** /panel-stream：校验 JWT 后随采样推送最新点，推送失败即断开 */
function panelStream(conn, req) {
  const payload = verifyToken(req.query?.token)
  if (!payload) {
    try {
      conn.sendMsg?.("未授权")
    } catch {}
    return conn.close?.()
  }
  conn.sendMsg?.(JSON.stringify({ type: "ready" }))
  const off = monitor.subscribe((point) => {
    try {
      conn.sendMsg?.(JSON.stringify({ type: "sample", point }))
    } catch {}
  })
  conn.on?.("close", off)
}

const router = express.Router()
router.use(express.json({ limit: "1mb" }))

router.use((req, res, next) => {
  try {
    ensureInit()
  } catch (err) {
    global.logger?.error?.("[面板] 初始化失败", err)
  }
  const conf = panelConf()
  if (conf.enable === false) return fail(res, 404, "面板未启用")
  next()
})

/* ---------------- 登录与账号 ---------------- */

router.get(
  "/api/public",
  wrap(async (req, res) => {
    ok(res, {
      needSetup: !isInitialized(),
      version: cfg.package?.version || "",
      name: "FMC-Yunzai",
    })
  }),
)

router.post(
  "/api/setup",
  wrap(async (req, res) => {
    if (isInitialized()) return fail(res, 400, "面板密码已设置")
    const password = String(req.body?.password || "")
    if (password.length < 8) return fail(res, 400, "密码长度至少 8 位")
    setPassword(password)
    plugins.audit("setup", "面板初始密码", "成功", req)
    ok(res, { token: issueToken(panelConf().tokenExpire) })
  }),
)

router.post(
  "/api/login",
  wrap(async (req, res) => {
    if (!isInitialized()) return fail(res, 400, "面板尚未设置密码")
    const conf = panelConf()
    const locked = loginLocked(req, conf.loginFailLimit)
    if (locked) return fail(res, 429, `尝试次数过多，请 ${locked} 秒后再试`)
    if (!verifyPassword(req.body?.password)) {
      recordFail(req)
      return fail(res, 401, "密码错误")
    }
    clearFail(req)
    ok(res, { token: issueToken(conf.tokenExpire), expire: Number(conf.tokenExpire) || 43200 })
  }),
)

router.get("/api/me", requireAuth, (req, res) => ok(res, { expire: req.panelAuth.exp }))

router.post(
  "/api/password",
  requireAuth,
  wrap(async (req, res) => {
    if (!verifyPassword(req.body?.oldPassword)) return fail(res, 400, "原密码错误")
    const password = String(req.body?.password || "")
    if (password.length < 8) return fail(res, 400, "密码长度至少 8 位")
    setPassword(password)
    plugins.audit("password", "修改面板密码", "成功", req)
    ok(res, { token: issueToken(panelConf().tokenExpire) })
  }),
)

/* ---------------- 总览与监控 ---------------- */

router.get(
  "/api/status",
  requireAuth,
  wrap(async (req, res) => {
    const [snapshot, ledger, pluginList] = await Promise.all([
      monitor.snapshot(),
      getLedger(),
      plugins.listPlugins(),
    ])
    const pluginItems = pluginList.items
    ok(res, {
      snapshot,
      version: cfg.package?.version || "",
      ledger: pluginList.ledger,
      plugins: {
        total: pluginItems.length,
        official: pluginItems.filter((i) => i.tier === "official").length,
        audited: pluginItems.filter((i) => i.tier === "audited").length,
        unknown: pluginItems.filter((i) => i.tier === "unknown").length,
        ahead: pluginItems.filter((i) => i.hashState === "ahead").map((i) => i.name),
        list: pluginItems,
      },
      audit: plugins.readAudit(20),
      ledgerItems: ledger.items.length,
      member: readMember(),
    })
  }),
)

router.get(
  "/api/monitor",
  requireAuth,
  wrap(async (req, res) => {
    const range = String(req.query?.range || "30m")
    ok(res, { series: monitor.series(range), snapshot: await monitor.snapshot(), latest: monitor.latest() })
  }),
)

/* ---------------- 插件管理 ---------------- */

router.get(
  "/api/plugins",
  requireAuth,
  wrap(async (req, res) => ok(res, await plugins.listPlugins())),
)

router.get(
  "/api/plugins/:name/readme",
  requireAuth,
  wrap(async (req, res) => ok(res, await plugins.readReadme(String(req.params.name)))),
)

router.get(
  "/api/plugins/audit",
  requireAuth,
  wrap(async (req, res) => ok(res, { items: plugins.readAudit(req.query?.limit) })),
)

router.post(
  "/api/plugins/install",
  requireAuth,
  wrap(async (req, res) => ok(res, await plugins.installPlugin({ url: req.body?.url, ack: req.body?.ack, req }))),
),

router.post(
  "/api/plugins/update",
  requireAuth,
  wrap(async (req, res) => ok(res, await plugins.updatePlugin({ name: String(req.body?.name || ""), ack: req.body?.ack, req }))),
),

router.post(
  "/api/plugins/uninstall",
  requireAuth,
  wrap(async (req, res) => ok(res, await plugins.uninstallPlugin({ name: String(req.body?.name || ""), req }))),
),

/* ---------------- 配置管理 ---------------- */

router.get(
  "/api/config/sources",
  requireAuth,
  wrap(async (req, res) => ok(res, { sources: sources() })),
)

router.get(
  "/api/config",
  requireAuth,
  wrap(async (req, res) => {
    const source = String(req.query?.source || "")
    if (!source) return fail(res, 400, "缺少 source")
    ok(res, { config: await readConfig(source, String(req.query?.file || "config")) })
  }),
)

router.post(
  "/api/config",
  requireAuth,
  wrap(async (req, res) => {
    const source = String(req.body?.source || "")
    if (!source) return fail(res, 400, "缺少 source")
    const fileKey = String(req.body?.file || "config")
    await confirmKeyFields(fileKey, req.body?.patches)
    const result = await writeConfig(source, fileKey, req.body?.patches, req.body?.values)
    plugins.audit("config", `${source}/${fileKey}`, "保存成功", req)
    ok(res, result)
  }),
)

router.get(
  "/api/config/groups",
  requireAuth,
  wrap(async (req, res) => ok(res, { groups: readGroups() })),
)

router.post(
  "/api/config/groups",
  requireAuth,
  wrap(async (req, res) => {
    const id = String(req.body?.id || "")
    if (req.body?.remove) {
      const result = await writeGroup(id, [], true)
      plugins.audit("config", `群配置 ${id}`, "清除覆盖", req)
      return ok(res, result)
    }
    if (!Array.isArray(req.body?.patches) || !req.body.patches.length) {
      return fail(res, 400, "没有需要保存的字段")
    }
    const result = await writeGroup(id, req.body.patches)
    plugins.audit("config", `群配置 ${id}`, "保存成功", req)
    ok(res, result)
  }),
)

router.post(
  "/api/config/group-default",
  requireAuth,
  wrap(async (req, res) => {
    const result = await writeGroupDefault(req.body?.patches || [])
    plugins.audit("config", "默认群配置", "保存成功", req)
    ok(res, result)
  }),
)

/* ---------------- 帮助菜单 ---------------- */

router.get(
  "/api/help",
  requireAuth,
  wrap(async (req, res) => {
    if (!help.helpAvailable()) return ok(res, { available: false })
    ok(res, { available: true, ...(await help.readHelp()) })
  }),
)

router.post(
  "/api/help",
  requireAuth,
  wrap(async (req, res) => {
    const result = await help.writeHelp(req.body || {})
    plugins.audit("help", "帮助菜单", "保存成功", req)
    ok(res, result)
  }),
)

/* ---------------- 日志与重启 ---------------- */

router.get(
  "/api/logs",
  requireAuth,
  wrap(async (req, res) => ok(res, readLogs({ file: req.query?.file, level: req.query?.level, limit: req.query?.limit }))),
)

router.get(
  "/api/logs/list",
  requireAuth,
  wrap(async (req, res) => ok(res, { files: listLogs() })),
)

router.post(
  "/api/restart",
  requireAuth,
  wrap(async (req, res) => {
    const Bot = global.Bot
    if (typeof Bot?.restart !== "function") return fail(res, 400, "当前运行方式不支持面板重启")
    plugins.audit("restart", "重启本体", "已触发", req)
    ok(res, { message: "正在重启" })
    setTimeout(() => {
      Bot.restart().catch?.((err) => global.logger?.error?.("[面板] 重启失败", err))
    }, 800)
  }),
)

/* ---------------- 静态页面 ---------------- */

router.use(express.static(PUBLIC_DIR, { index: "index.html", maxAge: 0 }))
// 未匹配的接口先返回 404，剩下的才交给前端路由
router.use("/api", (req, res) => fail(res, 404, "接口不存在"))
router.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"), (err) => {
    if (err) res.status(404).send("panel not found")
  })
})

/** 统一错误兜底：静态资源之外的异常不打印整段 HTML */
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err)
  fail(res, 500, String(err?.message || err))
})

export default router
export { panelConf }
