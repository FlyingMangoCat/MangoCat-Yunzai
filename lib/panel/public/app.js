const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const state = {
  token: localStorage.getItem("fmc-token") || "",
  page: "dashboard",
  status: null,
  range: "30m",
  monitor: null,
  transport: "poll",
  ws: null,
  sources: null,
  cfgSource: "",
  cfgFile: "",
  cfgData: null,
  groups: null,
  help: null,
  logs: { file: "", level: "" },
  timer: null,
  logsTimer: null,
}

/* ---------- 图标（线性描边） ---------- */

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 10v10h14V10"/>',
  puzzle:
    '<path d="M9 4h6v3a2 2 0 1 0 4 0h1v5h-3a2 2 0 1 0 0 4h3v4h-5v-2a2 2 0 1 0-4 0v2H4v-5h2a2 2 0 1 0 0-4H4V5h5z"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  sliders: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  file: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/><path d="M8 13h8M8 17h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 0-2 2z"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3"/><path d="M8 14h8v7H8z"/>',
  play: '<path d="M7 4l12 8-12 8z"/>',
}

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24">${ICONS[name] || ""}</svg>`
}

/* ---------- 基础工具 ---------- */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function fmtBytes(bytes, digits = 1) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${units[i]}`
}

function fmtNum(n, digits = 0) {
  const v = Number(n)
  if (!Number.isFinite(v)) return "-"
  return v.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${m} 分`
  if (m) return `${m} 分 ${s % 60} 秒`
  return `${s} 秒`
}

function fmtRate(bytesPerSec) {
  if (bytesPerSec === null || bytesPerSec === undefined) return "不可采集"
  return `${fmtBytes(bytesPerSec)}/s`
}

function fmtTime(iso) {
  if (!iso) return "-"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString("zh-CN", { hour12: false })
}

function toast(message, isError = false) {
  const node = document.createElement("div")
  node.className = `toast${isError ? " err" : ""}`
  node.textContent = String(message)
  $("#toastRoot").appendChild(node)
  setTimeout(() => node.remove(), 4200)
}

/* ---------- 接口 ---------- */

async function api(path, { method = "GET", body } = {}) {
  const headers = {}
  if (body !== undefined) headers["Content-Type"] = "application/json"
  if (state.token) headers.Authorization = `Bearer ${state.token}`
  const res = await fetch(`./api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = {}
  try {
    data = await res.json()
  } catch {
    data = { ok: false, message: `HTTP ${res.status}` }
  }
  if (res.status === 401) {
    logout()
    throw new Error("登录态已过期，请重新登录")
  }
  if (!res.ok || data.ok === false) throw new Error(data.message || `HTTP ${res.status}`)
  return data
}

/* ---------- 弹窗 ---------- */

function openModal({ title, body, footer, narrow = false, onMount }) {
  const mask = document.createElement("div")
  mask.className = "modal-mask"
  mask.innerHTML = `<div class="modal${narrow ? " narrow" : ""}">
    <div class="modal-head"><h3>${esc(title)}</h3><div class="spacer"></div>
      <button class="btn small" data-close>关闭</button></div>
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
  </div>`
  const close = () => mask.remove()
  mask.addEventListener("click", (e) => {
    if (e.target === mask || e.target.closest("[data-close]")) close()
  })
  $("#modalRoot").appendChild(mask)
  onMount?.(mask, close)
  return { el: mask, close }
}

/* ---------- 登录 / 初始化 ---------- */

let needSetup = false

function showAuth() {
  $("#appView").classList.add("hidden")
  $("#authView").classList.remove("hidden")
  $("#authError").textContent = ""
  $("#authPassword").value = ""
  $("#authConfirm").value = ""
  $("#authConfirmField").classList.toggle("hidden", !needSetup)
  $("#authSub").textContent = needSetup ? "首次使用，设置面板密码" : "管理面板登录"
  $("#authLabel").textContent = needSetup ? "设置密码" : "面板密码"
  $("#authSubmit").textContent = needSetup ? "设置并登录" : "登录"
  $("#authHint").textContent = needSetup
    ? "密码保存为 scrypt 派生值，至少 8 位；忘记密码可删除 data/panel/auth.json 后重启。"
    : "登录态有效期由 panel.tokenExpire 控制，默认 12 小时。"
  $("#authPassword").focus()
}

async function checkAuth() {
  try {
    const data = await api("/public")
    needSetup = !!data.needSetup
    if (!state.token) return showAuth()
    await api("/me")
    boot()
  } catch {
    if (needSetup) return showAuth()
    state.token = ""
    localStorage.removeItem("fmc-token")
    showAuth()
  }
}

async function submitAuth(event) {
  event.preventDefault()
  $("#authError").textContent = ""
  const password = $("#authPassword").value
  try {
    if (needSetup) {
      if (password.length < 8) throw new Error("密码长度至少 8 位")
      if (password !== $("#authConfirm").value) throw new Error("两次输入的密码不一致")
      const data = await api("/setup", { method: "POST", body: { password } })
      state.token = data.token
    } else {
      const data = await api("/login", { method: "POST", body: { password } })
      state.token = data.token
    }
    localStorage.setItem("fmc-token", state.token)
    boot()
  } catch (err) {
    $("#authError").textContent = err.message
  }
}

function logout() {
  state.token = ""
  localStorage.removeItem("fmc-token")
  clearInterval(state.timer)
  clearInterval(state.logsTimer)
  try {
    state.ws?.close()
  } catch {}
  state.ws = null
  showAuth()
}

/* ---------- 框架 ---------- */

const NAV = [
  { group: "概览", items: [{ id: "dashboard", label: "主页", icon: "home" }] },
  {
    group: "管理",
    items: [
      { id: "plugins", label: "插件管理", icon: "puzzle" },
      { id: "config", label: "配置管理", icon: "sliders" },
      { id: "help", label: "帮助菜单", icon: "list" },
    ],
  },
  {
    group: "运维",
    items: [
      { id: "monitor", label: "资源监控", icon: "activity" },
      { id: "logs", label: "运行日志", icon: "file" },
      { id: "account", label: "面板账号", icon: "user" },
    ],
  },
]

function renderNav() {
  $("#sideNav").innerHTML = NAV.map(
    (group) => `<div class="nav-group">
      <div class="nav-label">${esc(group.group)}</div>
      ${group.items
        .map(
          (item) =>
            `<div class="nav-item${state.page === item.id ? " active" : ""}" data-page="${item.id}">${icon(item.icon)}<span>${esc(item.label)}</span></div>`,
        )
        .join("")}
    </div>`,
  ).join("")
  $$("#sideNav .nav-item").forEach((node) =>
    node.addEventListener("click", () => go(node.dataset.page)),
  )
}

function go(page) {
  if (state.page === page) return
  state.page = page
  clearInterval(state.logsTimer)
  state.logsTimer = null
  renderNav()
  render()
}

const PAGES = {
  dashboard: renderDashboard,
  plugins: renderPlugins,
  monitor: renderMonitor,
  config: renderConfig,
  help: renderHelp,
  logs: renderLogs,
  account: renderAccount,
}

function render() {
  const fn = PAGES[state.page] || renderDashboard
  $("#mainView").innerHTML = `<div class="loading">加载中</div>`
  Promise.resolve(fn()).catch((err) => {
    $("#mainView").innerHTML = `<div class="card"><div class="empty">${esc(err.message)}</div></div>`
  })
}

async function loadStatus() {
  const data = await api("/status")
  state.status = data
  renderHeader(data)
  return data
}

function renderHeader(data) {
  const snap = data.snapshot
  $("#onlineDot").style.background = snap.online ? "var(--green)" : "var(--red)"
  $("#headerStatus").innerHTML = `
    <span>在线账号<b>${esc(snap.accounts.join(" / ") || "-")}</b></span>
    <span>今日消息<b>${fmtNum(snap.msgsToday)}</b></span>
    <span>运行时长<b>${esc(fmtDuration(snap.uptime))}</b></span>`
}

function statusStrip(snap) {
  return `<div class="grid c4" style="margin-bottom:14px">
    <div class="stat"><div class="v">${esc(snap.accounts.join(" / ") || "未登录")}</div><div class="k">在线账号</div>
      <div class="f">${snap.groups} 个群聊可用</div></div>
    <div class="stat"><div class="v" style="color:${snap.online ? "var(--green)" : "var(--red)"}">${snap.online ? "运行中" : "离线"}</div><div class="k">服务状态</div>
      <div class="f">HTTP ${snap.online ? "正常" : "不可用"}</div></div>
    <div class="stat"><div class="v">${fmtNum(snap.msgsToday)}</div><div class="k">今日消息</div>
      <div class="f">按消息事件计数</div></div>
    <div class="stat"><div class="v">${esc(fmtDuration(snap.uptime))}</div><div class="k">运行时长</div>
      <div class="f">开机至今</div></div>
  </div>`
}

async function boot() {
  $("#authView").classList.add("hidden")
  $("#appView").classList.remove("hidden")
  renderNav()
  try {
    await loadStatus()
  } catch (err) {
    toast(err.message, true)
  }
  render()
  clearInterval(state.timer)
  state.timer = setInterval(() => {
    loadStatus().catch(() => {})
    if (state.page === "monitor") refreshMonitorCharts()
  }, 15000)
  connectStream()
}

function connectStream() {
  try {
    state.ws?.close()
  } catch {}
  const proto = location.protocol === "https:" ? "wss:" : "ws:"
  const url = `${proto}//${location.host}/panel-stream?token=${encodeURIComponent(state.token)}`
  let ws
  try {
    ws = new WebSocket(url)
  } catch {
    state.transport = "poll"
    return
  }
  state.ws = ws
  ws.onopen = () => {
    state.transport = "stream"
  }
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.type === "sample" && data.point) {
        state.latestPoint = data.point
        if (state.page === "monitor") appendLivePoint(data.point)
      }
    } catch {}
  }
  ws.onerror = () => {
    state.transport = "poll"
  }
  ws.onclose = () => {
    state.transport = "poll"
  }
}

/* ---------- 主页 ---------- */

async function renderDashboard() {
  const data = state.status || (await loadStatus())
  const snap = data.snapshot
  const p = data.plugins
  const ledger = data.ledger
  const member = data.member
  const alerts = []
  if (ledger.stale) alerts.push({ level: "warn", text: `台账缓存已过期（${esc(ledger.error || "远端不可达")}），显示的是上一次结果` })
  if (p.ahead.length) alerts.push({ level: "warn", text: `${p.ahead.length} 个插件的本地版本超出台账记录：${esc(p.ahead.join("、"))}` })
  if (ledger.source === "none" || data.ledgerItems === 0) alerts.push({ level: "high", text: "台账尚未取到内容，插件信任判定全部按未收录处理" })

  const helpList = p.list
    .slice()
    .sort((a, b) => (a.tier === b.tier ? a.name.localeCompare(b.name) : a.tier.localeCompare(b.tier)))

  $("#mainView").innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><h2>警报</h2><div class="spacer"></div>
        <span class="badge ${alerts.length ? "amber" : "green"}">${alerts.length ? alerts.length + " 项" : "无异常"}</span></div>
      ${alerts.length ? `<table class="tbl"><thead><tr><th style="width:70px">级别</th><th>内容</th></tr></thead><tbody>${alerts
        .map(
          (a) => `<tr><td><span class="badge ${a.level === "high" ? "red" : "amber"}">${a.level === "high" ? "严重" : "警告"}</span></td><td>${a.text}</td></tr>`,
        )
        .join("")}</tbody></table>` : `<div class="empty" style="padding:10px 0">台账与插件版本都在记录范围内</div>`}
    </div>

    ${statusStrip(snap)}

    <div class="card">
      <div class="card-head"><h2>摘要</h2><div class="sub">关键状态一览</div></div>
      <table class="tbl">
        <tr><td class="muted" style="width:150px">CPU / 内存</td><td>${snap.cpu.toFixed(1)}%  ${fmtBytes(snap.memUsed)} / ${fmtBytes(snap.memTotal)}（${snap.memPercent.toFixed(1)}%）</td></tr>
        <tr><td class="muted">Redis</td><td>${snap.redis ? `已连接  ${fmtNum(snap.redis.keys)} 个键` : "未连接"}</td></tr>
        <tr><td class="muted">收录插件</td><td>${p.official + p.audited} 个（官方 ${p.official} · 已收录 ${p.audited} · 未收录 ${p.unknown}）</td></tr>
        <tr><td class="muted">版本哈希一致</td><td>${p.list.filter((i) => i.hashState === "match").length} 个（未收录插件不参与比对）</td></tr>
        <tr><td class="muted">台账</td><td>${data.ledgerItems} 条  来源 ${esc(ledger.source)}  更新于 ${fmtTime(ledger.at ? new Date(ledger.at).toISOString() : "")}</td></tr>
        <tr><td class="muted">本体版本</td><td>${esc(data.version || "-")}  ${esc(snap.system.platform)}</td></tr>
      </table>
    </div>

    ${member ? `<div class="card" style="margin-top:14px">
      <div class="card-head"><h2>榴莲会员</h2><div class="spacer"></div>
        <span class="badge ${member.active ? "green" : "red"}">${member.active ? "生效中" : "已过期"}</span></div>
      <div class="kv">
        <div><span>剩余时长</span><span>${member.remainingDays === null ? "-" : `${member.remainingDays} 天`}</span></div>
        <div><span>有效期至</span><span>${esc(fmtTime(member.expire))}</span></div>
      </div>
    </div>` : ""}

    <div class="card">
      <div class="card-head"><h2>插件信任概览</h2><div class="sub">按台账等级排序</div><div class="spacer"></div>
        <button class="btn small" data-goto="plugins">进入插件管理</button></div>
      <table class="tbl">
        <thead><tr><th>插件</th><th>版本</th><th>等级</th><th>版本哈希</th><th>检查日期</th></tr></thead>
        <tbody>
          ${helpList
            .map(
              (i) => `<tr>
              <td><span class="mono">${esc(i.name)}</span></td>
              <td>${esc(i.version || "-")}</td>
              <td>${tierBadge(i)}</td>
              <td>${hashBadge(i)}</td>
              <td class="mono">${esc(i.ledger?.checkDate || "-")}</td>
            </tr>`,
            )
            .join("") || `<tr><td colspan="5"><div class="empty">尚未安装插件</div></td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-head"><h2>最近敏感操作</h2><div class="sub">面板内的安装、卸载、更新、配置与重启</div></div>
      ${auditTable(data.audit)}
    </div>`

  $$("[data-goto]").forEach((node) =>
    node.addEventListener("click", () => go(node.dataset.goto)),
  )
}

function tierBadge(item) {
  if (item.tier === "official") return `<span class="badge green">官方</span>`
  if (item.tier === "audited") return `<span class="badge blue">已收录</span>`
  return `<span class="badge">未收录</span>`
}

function hashBadge(item) {
  if (item.hashState === "match") return `<span class="badge green">一致</span>`
  if (item.hashState === "ahead") return `<span class="badge amber">超出台账</span>`
  if (item.hashState === "unknown") return `<span class="badge">无法比对</span>`
  return `<span class="badge">未记录</span>`
}

function auditTable(items) {
  if (!items?.length) return `<div class="empty">暂无记录</div>`
  return `<table class="tbl">
    <thead><tr><th>时间</th><th>操作</th><th>对象</th><th>结果</th><th>来源</th></tr></thead>
    <tbody>${items
      .map(
        (i) => `<tr>
        <td class="mono">${esc(fmtTime(i.t))}</td>
        <td>${esc(i.action)}</td>
        <td class="mono" style="max-width:280px;word-break:break-all">${esc(i.target)}</td>
        <td>${esc(i.result)}</td>
        <td class="mono">${esc(i.ip)}</td>
      </tr>`,
      )
      .join("")}</tbody>
  </table>`
}

/* ---------- 插件管理 ---------- */

async function renderPlugins() {
  const data = await api("/plugins")
  const items = data.items || []
  const ledger = data.ledger || {}

  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>插件管理</h1>
      <p>信任判定以收录台账为准；安装、更新、卸载都需要主人私聊确认</p>
      <div class="spacer"></div>
      <span class="badge ${ledger.stale ? "amber" : "green"}">台账 ${ledger.stale ? "缓存" : esc(ledger.source)}</span>
      <button class="btn small" id="btnLedgerRefresh">重新拉取台账</button>
    </div>

    <div class="card">
      <div class="card-head"><h2>收录列表</h2><div class="sub">共 ${items.length} 个</div></div>
      <table class="tbl">
        <thead><tr><th>插件</th><th>版本</th><th>HEAD</th><th>等级</th><th>版本哈希</th><th>说明</th><th style="width:210px"></th></tr></thead>
        <tbody>
          ${items
            .map(
              (i) => `<tr data-name="${esc(i.name)}">
              <td><span class="mono">${esc(i.name)}</span>${i.hasGuoba ? ` <span class="badge">配置</span>` : ""}</td>
              <td>${esc(i.version || "-")}</td>
              <td class="mono">${esc(i.head || "-")}</td>
              <td>${tierBadge(i)}</td>
              <td>${hashBadge(i)}</td>
              <td class="small muted" style="max-width:280px">${esc(i.ledger?.note || i.description || "-")}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn small" data-act="readme" ${i.hasReadme ? "" : "disabled"}>README</button>
                <button class="btn small" data-act="update">更新</button>
                <button class="btn small danger" data-act="uninstall">卸载</button>
              </td>
            </tr>`,
            )
            .join("") || `<tr><td colspan="7"><div class="empty">尚未安装插件</div></td></tr>`}
        </tbody>
      </table>
    </div>

    ${state.status?.member ? `<div class="card">
      <div class="card-head"><h2>榴莲会员</h2><div class="spacer"></div>
        <span class="badge ${state.status.member.active ? "green" : "red"}">${state.status.member.active ? "生效中" : "已过期"}</span></div>
      <div class="kv">
        <div><span>剩余时长</span><span>${state.status.member.remainingDays === null ? "-" : `${state.status.member.remainingDays} 天`}</span></div>
        <div><span>有效期至</span><span>${esc(fmtTime(state.status.member.expire))}</span></div>
      </div>
    </div>` : ""}

    <div class="card">
      <div class="card-head"><h2>安装未收录插件</h2><div class="sub">仓库域名需在 panel.install.domains 白名单内</div></div>
      <div class="field">
        <label for="installUrl">仓库地址</label>
        <input class="input" id="installUrl" placeholder="https://github.com/owner/repo" />
      </div>
      <div class="field">
        <label class="switch"><input type="checkbox" id="installAck" /><span class="small">我已知悉风险：该插件不在收录台账内，出现任何问题自行承担</span></label>
      </div>
      <button class="btn primary" id="btnInstall">${icon("download")}安装</button>
    </div>

    <div class="card">
      <div class="card-head"><h2>最近敏感操作</h2></div>
      ${auditTable(state.status?.audit)}
    </div>`

  $("#btnLedgerRefresh").addEventListener("click", async () => {
    try {
      await api("/status?ledger=force")
      await loadStatus()
      toast("已重新拉取台账")
      render()
    } catch (err) {
      toast(err.message, true)
    }
  })

  $("#btnInstall").addEventListener("click", async () => {
    const url = $("#installUrl").value.trim()
    const ack = $("#installAck").checked
    if (!url) return toast("请填写仓库地址", true)
    if (!confirm(`确认安装 ${url}？\n安装前会向主人私聊发送确认请求。`)) return
    try {
      $("#btnInstall").disabled = true
      const res = await api("/plugins/install", { method: "POST", body: { url, ack } })
      toast(`已安装到 plugins/${res.dir}，重启后生效`)
      render()
    } catch (err) {
      toast(err.message, true)
    } finally {
      const btn = $("#btnInstall")
      if (btn) btn.disabled = false
    }
  })

  $$("#mainView tbody tr[data-name]").forEach((row) => {
    row.addEventListener("click", async (event) => {
      const act = event.target.closest("[data-act]")?.dataset.act
      if (!act) return
      const name = row.dataset.name
      if (act === "readme") return showReadme(name)
      if (act === "update") {
        if (!confirm(`确认更新插件 ${name}？\n更新前会向主人私聊发送确认请求。`)) return
        const doUpdate = async (ack) => {
          const res = await api("/plugins/update", { method: "POST", body: { name, ack } })
          openModal({
            title: `更新 ${name}`,
            body: `<pre class="readme">${esc(res.output || "已是最新版本")}</pre>`,
          })
        }
        try {
          await doUpdate(false)
        } catch (err) {
          if (!/风险确认/.test(err.message)) return toast(err.message, true)
          if (!confirm(err.message)) return
          try {
            await doUpdate(true)
          } catch (err2) {
            toast(err2.message, true)
          }
        }
      }
      if (act === "uninstall") {
        if (!confirm(`确认卸载插件 ${name}？\\n目录会移动到 data/panel_removed/ 下保留，不直接删除。`)) return
        try {
          const res = await api("/plugins/uninstall", { method: "POST", body: { name } })
          toast(`已移动到 ${res.movedTo}，重启后生效`)
          render()
        } catch (err) {
          toast(err.message, true)
        }
      }
    })
  })
}

async function showReadme(name) {
  try {
    const data = await api(`/plugins/${encodeURIComponent(name)}/readme`)
    openModal({
      title: `${name} / ${data.file}`,
      body: `<pre class="readme">${esc(data.text)}${data.truncated ? "\\n\\n（内容过长，已截断）" : ""}</pre>`,
    })
  } catch (err) {
    toast(err.message, true)
  }
}

/* ---------- 图表 ---------- */

function seriesValues(points, key, transform) {
  return points.map((p) => {
    const v = p[key]
    if (v === null || v === undefined || Number.isNaN(Number(v))) return null
    return transform ? transform(Number(v)) : Number(v)
  })
}

function linePath(values, width, height, pad) {
  const max = Math.max(...values.filter((v) => v !== null), 1)
  const n = Math.max(1, values.length - 1)
  const x = (i) => pad + (i / n) * (width - pad * 2)
  const y = (v) => height - pad - (v / max) * (height - pad * 2)
  let line = ""
  let started = false
  values.forEach((v, i) => {
    if (v === null) return
    line += `${started ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `
    started = true
  })
  const first = values.findIndex((v) => v !== null)
  const last = values.length - 1 - [...values].reverse().findIndex((v) => v !== null)
  const area =
    line && first >= 0
      ? `${line}L${x(last).toFixed(1)} ${height - pad} L${x(first).toFixed(1)} ${height - pad} Z`
      : ""
  return { line: line.trim(), area, max }
}

/** 单值折线：渐变面积填充 + 描边，末点脉动标记 */
let chartSeq = 0
function chartSVG(values, color = "#2f6fed") {
  const width = 320
  const height = 110
  const pad = 8
  const { line, area, max } = linePath(values, width, height, pad)
  if (!line) return `<div class="empty" style="padding:18px 0">暂无数据</div>`
  const id = `g${++chartSeq}`
  const lastIdx = values.length - 1 - [...values].reverse().findIndex((v) => v !== null)
  const cx = pad + (lastIdx / Math.max(1, values.length - 1)) * (width - pad * 2)
  const cy = height - pad - (values[lastIdx] / max) * (height - pad * 2)
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.3" /><stop offset="1" stop-color="${color}" stop-opacity="0" />
    </linearGradient></defs>
    <path d="${area}" fill="url(#${id})" stroke="none" />
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" />
    <circle class="pulse" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.2" fill="${color}" />
    <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.2" fill="${color}" />
  </svg>`
}

/** 双值折线：两条描边，不填充，便于对比读写/上下行 */
function chartPairSVG(valuesA, valuesB, colorA = "#2f6fed", colorB = "#1a9c63") {
  const width = 320
  const height = 110
  const pad = 8
  const maxA = Math.max(...valuesA.filter((v) => v !== null), 1)
  const maxB = Math.max(...valuesB.filter((v) => v !== null), 1)
  const max = Math.max(maxA, maxB)
  const build = (values) => {
    const n = Math.max(1, values.length - 1)
    const x = (i) => pad + (i / n) * (width - pad * 2)
    const y = (v) => height - pad - (v / max) * (height - pad * 2)
    let d = ""
    let started = false
    values.forEach((v, i) => {
      if (v === null) return
      d += `${started ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `
      started = true
    })
    return d.trim()
  }
  const a = build(valuesA)
  const b = build(valuesB)
  if (!a && !b) return `<div class="empty" style="padding:18px 0">暂无数据</div>`
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
    ${a ? `<path d="${a}" fill="none" stroke="${colorA}" stroke-width="1.6" vector-effect="non-scaling-stroke" />` : ""}
    ${b ? `<path d="${b}" fill="none" stroke="${colorB}" stroke-width="1.6" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />` : ""}
  </svg>`
}

function ringSVG(percent, color = "#2f6fed", label = "", caption = "") {
  const value = Math.max(0, Math.min(100, Number(percent) || 0))
  const r = 26
  const c = 2 * Math.PI * r
  const dash = (value / 100) * c
  return `<div class="ring">
    <svg viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="#eef0f3" stroke-width="7" />
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="7"
        stroke-linecap="round" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}"
        transform="rotate(-90 32 32)" />
      <text x="32" y="35.5" text-anchor="middle" font-size="12" fill="#1f2328">${value.toFixed(0)}%</text>
    </svg>
    <div class="cap">${esc(label)}${caption ? `<br /><span class="small muted">${esc(caption)}</span>` : ""}</div>
  </div>`
}

/* ---------- 资源监控 ---------- */

const RANGES = [
  ["30m", "30 分钟"],
  ["6h", "6 小时"],
  ["12h", "12 小时"],
  ["1d", "1 天"],
  ["1w", "1 周"],
  ["1m", "1 月"],
]

async function renderMonitor() {
  const data = await api(`/monitor?range=${encodeURIComponent(state.range)}`)
  state.monitor = data
  const snap = data.snapshot
  const transport = state.transport === "stream" ? "WebSocket 推送" : "HTTP 轮询"
  const points = data.series.points || []

  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>资源监控</h1>
      <p>实时采样 · 10 秒刷新 · ${esc(transport)}</p>
    </div>

    ${statusStrip(snap)}

    <div class="card">
      <div class="card-head"><h2>趋势监控</h2><div class="sub">当前窗口 ${esc(RANGES.find((i) => i[0] === state.range)?.[1] || "")}</div><div class="spacer"></div>
        <div class="range-bar">
          ${RANGES.map(([key, label]) => `<button data-range="${key}" class="${key === state.range ? "active" : ""}">${label}</button>`).join("")}
        </div>
      </div>
      <div class="grid c3" id="trendGrid">
      <div class="mcard">
        <div class="chart-title"><b>消息量</b><span class="unit">条 / 采样段</span>
          <span class="val">当前 ${fmtNum(points.at(-1)?.msgs ?? 0)}</span></div>
        ${chartSVG(seriesValues(points, "msgs"), "#2f6fed")}
      </div>
      <div class="mcard">
        <div class="chart-title"><b>CPU</b><span class="unit">%</span>
          <span class="val">当前 ${snap.cpu.toFixed(1)}%</span></div>
        ${chartSVG(seriesValues(points, "cpu"), "#2f6fed")}
      </div>
      <div class="mcard">
        <div class="chart-title"><b>内存</b><span class="unit">%</span>
          <span class="val">当前 ${snap.memPercent.toFixed(1)}%</span></div>
        ${chartSVG(seriesValues(points, "mem"), "#1a9c63")}
      </div>
      <div class="mcard">
        <div class="chart-title"><b>磁盘读写</b><span class="unit">实线读 / 虚线写</span>
          <span class="val">${snap.diskSupported ? `${fmtRate(snap.diskIO?.read)} · ${fmtRate(snap.diskIO?.write)}` : "当前平台不可采集"}</span></div>
        ${snap.diskSupported ? chartPairSVG(seriesValues(points, "diskRead"), seriesValues(points, "diskWrite"), "#2f6fed", "#b8791b") : `<div class="empty" style="padding:18px 0">该平台没有 /proc/diskstats</div>`}
      </div>
      <div class="mcard">
        <div class="chart-title"><b>网络上下行</b><span class="unit">实线收 / 虚线发</span>
          <span class="val">${snap.netSupported ? `${fmtRate(snap.net?.rx)} · ${fmtRate(snap.net?.tx)}` : "当前平台不可采集"}</span></div>
        ${snap.netSupported ? chartPairSVG(seriesValues(points, "netRx"), seriesValues(points, "netTx"), "#2f6fed", "#1a9c63") : `<div class="empty" style="padding:18px 0">该平台没有 /proc/net/dev</div>`}
      </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-head"><h2>内存与交换</h2><div class="sub">CPU ${esc(snap.system.cpuCount)} 核 ${esc(snap.system.cpuModel)}</div></div>
      <div class="ring-row">
        ${ringSVG(snap.cpu, "#2f6fed", "CPU", `负载 ${snap.load ? snap.load.join(" / ") : "不可采集"}`)}
        ${ringSVG(snap.memPercent, "#1a9c63", "内存", `${fmtBytes(snap.memUsed)} / ${fmtBytes(snap.memTotal)}`)}
        ${
          snap.swap
            ? ringSVG(snap.swap.total ? (snap.swap.used / snap.swap.total) * 100 : 0, "#b8791b", "SWAP", snap.swap.total ? `${fmtBytes(snap.swap.used)} / ${fmtBytes(snap.swap.total)}` : "未启用")
            : `<div class="ring"><div class="cap">SWAP 不可采集</div></div>`
        }
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>磁盘占用</h2><div class="sub">同一分区上的位置合并展示</div></div>
      <div class="share-list">
        ${(snap.disk || [])
          .map((d) => {
            const labels = (d.labels || [d.label]).join(" / ")
            const targets = (d.targets || [d.path]).join("　")
            const pct = Math.min(100, d.percent).toFixed(1)
            const grad = d.percent > 88 ? "linear-gradient(90deg,#e08a7a,#cf3b34)" : "linear-gradient(90deg,#5a86ff,#3b6ef5)"
            return `<div class="share">
            <div class="row"><b>${esc(labels)}</b><span class="muted mono">${esc(targets)}</span>
              <span class="muted">${fmtBytes(d.used)} / ${fmtBytes(d.total)}</span></div>
            <div style="height:14px;background:#eef1f5;border-radius:5px;position:relative;overflow:hidden">
              <div style="height:14px;width:${pct}%;background:${grad};border-radius:5px"></div>
              <span style="position:absolute;inset:0;text-align:center;font-size:11px;line-height:14px;color:#fff;font-weight:600">${pct}%</span>
            </div>
          </div>`
          })
          .join("") || `<div class="empty">不可采集</div>`}
      </div>
      <div class="small muted" style="margin-top:10px">读写速率：${snap.diskSupported ? `${fmtRate(snap.diskIO?.read)} 读 · ${fmtRate(snap.diskIO?.write)} 写` : "当前平台不可采集"}</div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Redis</h2><div class="sub">${snap.redis ? `版本 ${esc(snap.redis.version)}` : "未连接"}</div></div>
      ${
        snap.redis
          ? `<div class="kv">
        <div><span>客户端</span><span>${fmtNum(snap.redis.clients)}</span></div>
        <div><span>历史连接</span><span>${fmtNum(snap.redis.totalConnections)}</span></div>
        <div><span>历史命令</span><span>${fmtNum(snap.redis.totalCommands)}</span></div>
        <div><span>db0 Keys</span><span>${fmtNum(snap.redis.keys)}</span></div>
        <div><span>Expires</span><span>${fmtNum(snap.redis.expires)}</span></div>
        <div><span>平均 TTL</span><span>${fmtNum(snap.redis.avgTtl)} ms</span></div>
        <div><span>命中 / 未命中</span><span>${fmtNum(snap.redis.hits)} / ${fmtNum(snap.redis.misses)}</span></div>
        <div><span>占用内存</span><span>${esc(snap.redis.usedMemoryHuman)}</span></div>
        <div><span>运行时长</span><span>${esc(fmtDuration(snap.redis.uptime))}</span></div>
      </div>`
          : `<div class="empty">Redis 未连接</div>`
      }
    </div>

    <div class="card">
      <div class="card-head"><h2>系统信息</h2></div>
      <div class="kv">
        <div><span>系统</span><span>${esc(snap.system.platform)} ${esc(snap.system.arch)}</span></div>
        <div><span>主机名</span><span>${esc(snap.system.hostname)}</span></div>
        <div><span>Node</span><span>${esc(snap.system.node)}</span></div>
        <div><span>CPU</span><span>${esc(snap.system.cpuCount)} 核</span></div>
        <div><span>内存总量</span><span>${fmtBytes(snap.system.totalMem)}</span></div>
        <div><span>进程内存</span><span>${fmtBytes(performance?.memory?.usedJSHeapSize || 0)}</span></div>
        <div><span>本体运行</span><span>${esc(fmtDuration(snap.uptime))}</span></div>
        <div><span>账号在线</span><span>${esc(snap.accounts.join(" / ") || "未登录")}</span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>服务组件</h2></div>
      <div class="kv">
        <div><span>HTTP 服务</span><span>${snap.online ? `<span class="badge green">正常</span>` : `<span class="badge red">离线</span>`}</span></div>
        <div><span>Redis</span><span>${snap.redis ? `<span class="badge green">已连接</span>` : `<span class="badge">未连接</span>`}</span></div>
        <div><span>消息统计</span><span>${snap.msgsToday ? `<span class="badge green">采集中</span>` : `<span class="badge">等待消息</span>`}</span></div>
        <div><span>采样通道</span><span><span class="badge ${state.transport === "stream" ? "green" : ""}">${esc(transport)}</span></span></div>
      </div>
    </div>`

  $$(".range-bar button").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.range = btn.dataset.range
      render()
    }),
  )
}

/** 监控页在停留期间按 15 秒补一次全量刷新；WebSocket 只负责最新点 */
async function refreshMonitorCharts() {
  if (state.page !== "monitor") return
  try {
    const data = await api(`/monitor?range=${encodeURIComponent(state.range)}`)
    state.monitor = data
    render()
  } catch {}
}

function appendLivePoint() {
  // 最新点只用于状态栏轻量刷新，趋势图跟随 15 秒补刷，避免整页重绘
  if (state.status?.snapshot && state.latestPoint) {
    const snap = state.status.snapshot
    snap.cpu = state.latestPoint.cpu
    snap.memUsed = state.latestPoint.memUsed
    snap.memPercent = state.latestPoint.memTotal ? (state.latestPoint.memUsed / state.latestPoint.memTotal) * 100 : 0
  }
}

/* ---------- 配置管理 ---------- */

function pathKey(p) {
  return JSON.stringify(p)
}

function fieldCurrentValue(field) {
  const key = pathKey(field.path)
  if (state.cfgDirty?.has(key)) return state.cfgDirty.get(key)
  if (field.type === "list") return (field.items || []).join("\n")
  return field.value ?? ""
}

function fieldHTML(field) {
  const key = pathKey(field.path)
  const data = `data-path='${esc(key)}' data-ftype="${esc(field.type)}"`
  const hint = field.hint ? `<div class="hint">${esc(field.hint)}</div>` : ""
  const label = `<label>${esc(field.label)}${field.sensitive ? ` <span class="badge">敏感</span>` : ""}</label>`

  if (field.type === "switch") {
    const checked = field.value === true || fieldCurrentValue(field) === true
    return `<div class="field"><label class="switch">
      <input type="checkbox" ${data} ${checked ? "checked" : ""} />
      <span>${esc(field.label)}</span></label>${hint}</div>`
  }
  if (field.type === "select") {
    const current = String(fieldCurrentValue(field) ?? "")
    const options = (field.options || [])
      .map((o) => {
        const value = String(o.value ?? "")
        return `<option value="${esc(value)}" ${current === value ? "selected" : ""}>${esc(o.label ?? value)}</option>`
      })
      .join("")
    return `<div class="field">${label}<select class="select" ${data} ${field.disabled ? "disabled" : ""}>${options}</select>${hint}</div>`
  }
  if (field.type === "number") {
    return `<div class="field">${label}<input class="input" type="number" ${data} value="${esc(fieldCurrentValue(field))}"
      ${field.min !== undefined ? `min="${esc(field.min)}"` : ""} ${field.max !== undefined ? `max="${esc(field.max)}"` : ""} />${hint}</div>`
  }
  if (field.type === "textarea" || field.type === "list") {
    const rows = field.type === "list" ? 4 : 5
    const placeholder = field.type === "list" ? "每行一项" : ""
    return `<div class="field">${label}<textarea class="textarea" rows="${rows}" ${data}
      placeholder="${placeholder}">${esc(fieldCurrentValue(field))}</textarea>${hint}</div>`
  }
  const sensitive = field.sensitive
  return `<div class="field">${label}<input class="input" type="${sensitive ? "password" : "text"}" ${data}
    value="${sensitive ? "" : esc(fieldCurrentValue(field))}"
    placeholder="${sensitive ? (field.set ? "已设置，留空不修改" : "未设置") : ""}" />${hint}</div>`
}

function groupBodyHTML(fields) {
  const plain = []
  const nested = []
  for (const field of fields || []) (field.type === "group" ? nested : plain).push(field)
  let html = plain.map(fieldHTML).join("")
  if (nested.length) {
    html += nested
      .map(
        (group) => `<div class="cfg-group" style="margin-top:10px">
        <div class="hd">${esc(group.label)}</div>
        <div class="bd">${groupBodyHTML(group.children)}</div>
      </div>`,
      )
      .join("")
  }
  return html
}

function fieldsHTML(fields) {
  if (!fields?.length) return `<div class="empty">没有可配置字段</div>`
  const groups = fields.filter((f) => f.type === "group")
  const plain = fields.filter((f) => f.type !== "group")
  const plainHTML = plain.length
    ? `<div class="card"><div class="card-head"><h2>常规</h2></div>${plain.map(fieldHTML).join("")}</div>`
    : ""
  const groupsHTML = groups.length
    ? `<div class="cfg-groups"${plainHTML ? ' style="margin-top:14px"' : ""}>${groups
        .map(
          (group) => `<div class="cfg-group">
          <div class="hd">${esc(group.label)}</div>
          <div class="bd">${group.hint ? `<div class="hint" style="margin-bottom:10px">${esc(group.hint)}</div>` : ""}${groupBodyHTML(group.children)}</div>
        </div>`,
        )
        .join("")}</div>`
    : ""
  return plainHTML + groupsHTML
}

function groupFieldsHTML(fields) {
  // 分组内再嵌套时直接拍平展示，群覆盖只需要叶字段
  const out = []
  const walk = (list) => {
    for (const field of list) {
      if (field.type === "group") walk(field.children || [])
      else out.push(field)
    }
  }
  walk(fields || [])
  return out.map(fieldHTML).join("")
}

function collectDirty(map) {
  if (!map) return []
  return [...map.values()]
}

function updateDirtyBar() {
  const bar = $("#dirtyBar")
  if (!bar) return
  const count = state.cfgDirty?.size || 0
  bar.style.display = count ? "flex" : "none"
  const label = $("#dirtyCount")
  if (label) label.textContent = `${count} 项待保存`
}

function bindConfigInputs(root) {
  $$("[data-path]", root).forEach((input) => {
    input.addEventListener("input", onConfigInput)
    input.addEventListener("change", onConfigInput)
  })
}

function onConfigInput(event) {
  const el = event.target
  const path = JSON.parse(el.dataset.path)
  const type = el.dataset.ftype
  let value
  if (type === "switch") value = el.checked
  else if (type === "number") value = el.value === "" ? 0 : Number(el.value)
  else if (type === "list") value = el.value.split("\n").map((i) => i.trim()).filter(Boolean)
  else value = el.value
  state.cfgDirty.set(pathKey(path), { path, value })
  updateDirtyBar()
}

async function renderConfig() {
  if (!state.sources) state.sources = (await api("/config/sources")).sources
  const sources = state.sources
  const src = sources.find((s) => s.id === state.cfgSource) || sources[0]
  if (!src) {
    $("#mainView").innerHTML = `<div class="card"><div class="empty">没有可管理的配置文件</div></div>`
    return
  }
  if (src.id !== state.cfgSource) state.cfgDirty = new Map()
  state.cfgSource = src.id
  const fileKey = src.files.some((f) => f.key === state.cfgFile) ? state.cfgFile : src.files[0]?.key || ""
  const changedFile = fileKey !== state.cfgFile
  state.cfgFile = fileKey
  if (changedFile) state.cfgDirty = new Map()

  const cfgData = (await api(`/config?source=${encodeURIComponent(src.id)}&file=${encodeURIComponent(fileKey)}`)).config
  const groups = (await api("/config/groups")).groups
  state.cfgData = cfgData

  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>配置管理</h1>
      <p>按配置文件结构生成表单，保存时只回写改动的字段</p>
      <div class="spacer"></div>
      <span class="badge ${cfgData.fromDefault ? "amber" : ""}">${cfgData.fromDefault ? "当前读的是默认模板" : "用户配置"}</span>
    </div>

    <div class="source-tabs">
      ${sources
        .map(
          (s) => `<button data-source="${esc(s.id)}" class="${s.id === src.id ? "active" : ""}">${esc(s.title)}</button>`,
        )
        .join("")}
    </div>

    ${
      src.files.length > 1
        ? `<div class="file-list">${src.files
            .map(
              (f) => `<button data-file="${esc(f.key)}" class="${f.key === fileKey ? "active" : ""}">${esc(f.title)}</button>`,
            )
            .join("")}</div>`
        : ""
    }

    <div class="small muted" style="margin-bottom:12px">
      更新于 ${esc(fmtTime(cfgData.updatedAt))}${cfgData.fromDefault ? "，保存后会写入用户配置目录" : ""}
    </div>

    <div id="cfgForm">${fieldsHTML(cfgData.fields)}</div>

    <div class="dirty-bar" id="dirtyBar" style="display:none">
      <span id="dirtyCount" class="small"></span>
      <div class="spacer" style="flex:1"></div>
      <button class="btn small" id="btnDiscard">放弃改动</button>
      <button class="btn small primary" id="btnSave">${icon("save")}保存</button>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-head"><h2>群组配置</h2><div class="sub">群覆盖在 group.yaml 中按群号单独记录，未覆盖的字段继承默认</div></div>
      <div class="source-tabs" id="groupTabs">
        <button data-gtab="default" class="active">默认</button>
        ${groups.groups.map((g) => `<button data-gtab="${esc(g.id)}">群 ${esc(g.id)}</button>`).join("")}
        <button data-gtab="new">新增覆盖</button>
      </div>
      <div id="groupPanel"></div>
    </div>`

  bindConfigInputs($("#cfgForm"))
  updateDirtyBar()

  $$(".source-tabs button[data-source]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.cfgSource = btn.dataset.source
      state.cfgFile = ""
      state.cfgDirty = new Map()
      render()
    }),
  )
  $$(".file-list button[data-file]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.cfgFile = btn.dataset.file
      state.cfgDirty = new Map()
      render()
    }),
  )

  $("#btnDiscard").addEventListener("click", () => {
    state.cfgDirty = new Map()
    render()
  })
  $("#btnSave").addEventListener("click", async () => {
    const patches = collectDirty(state.cfgDirty)
    if (!patches.length) return
    if (!confirm(`确认保存 ${patches.length} 项改动？\\n原文件会备份到 data/panel_backup/。`)) return
    try {
      $("#btnSave").disabled = true
      if (src.kind === "schema") {
        const values = {}
        for (const patch of patches) values[patch.path[0]] = patch.value
        await api("/config", { method: "POST", body: { source: src.id, file: fileKey, values } })
      } else {
        await api("/config", { method: "POST", body: { source: src.id, file: fileKey, patches } })
      }
      toast("已保存")
      state.cfgDirty = new Map()
      await loadStatus().catch(() => {})
      render()
    } catch (err) {
      toast(err.message, true)
      const btn = $("#btnSave")
      if (btn) btn.disabled = false
    }
  })

  renderGroupPanel(groups, "default")
  $$("#groupTabs button[data-gtab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      $$("#groupTabs button").forEach((i) => i.classList.remove("active"))
      btn.classList.add("active")
      renderGroupPanel(groups, btn.dataset.gtab)
    }),
  )
}

function renderGroupPanel(groups, tab) {
  state.groupDirty = new Map()
  const panel = $("#groupPanel")
  if (!panel) return

  if (tab === "new") {
    panel.innerHTML = `
      <div class="field"><label>群号</label><input class="input" id="newGroupId" placeholder="例如 123456789" style="max-width:220px" /></div>
      <div class="cfg-groups">${groupFieldsHTML(groups.defaultFields)}</div>
      <div style="margin-top:12px"><button class="btn primary small" id="btnGroupCreate">创建覆盖</button></div>`
    bindGroupInputs(panel, "new")
    $("#btnGroupCreate").addEventListener("click", async () => {
      const id = $("#newGroupId").value.trim()
      const patches = collectDirty(state.groupDirty.get("new"))
      if (!/^\\d{5,12}$/.test(id)) return toast("群号不合法", true)
      if (!patches.length) return toast("没有需要保存的字段", true)
      try {
        await api("/config/groups", { method: "POST", body: { id, patches } })
        toast("已创建群覆盖")
        render()
      } catch (err) {
        toast(err.message, true)
      }
    })
    return
  }

  if (tab === "default") {
    panel.innerHTML = `
      <div class="cfg-groups">${groupFieldsHTML(groups.defaultFields)}</div>
      <div style="margin-top:12px"><button class="btn primary small" id="btnGroupDefaultSave">保存默认配置</button></div>`
    bindGroupInputs(panel, "default")
    $("#btnGroupDefaultSave").addEventListener("click", async () => {
      const patches = collectDirty(state.groupDirty.get("default"))
      if (!patches.length) return toast("没有改动", true)
      try {
        await api("/config/group-default", { method: "POST", body: { patches } })
        toast("已保存默认群配置")
        render()
      } catch (err) {
        toast(err.message, true)
      }
    })
    return
  }

  const group = groups.groups.find((g) => g.id === tab)
  if (!group) {
    panel.innerHTML = `<div class="empty">该群没有覆盖配置</div>`
    return
  }
  panel.innerHTML = `
    <div class="cfg-groups">${groupFieldsHTML(group.fields)}</div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn primary small" id="btnGroupSave">保存群 ${esc(group.id)}</button>
      <button class="btn danger small" id="btnGroupRemove">清除该群覆盖</button>
    </div>`
  bindGroupInputs(panel, group.id)
  $("#btnGroupSave").addEventListener("click", async () => {
    const patches = collectDirty(state.groupDirty.get(group.id))
    if (!patches.length) return toast("没有改动", true)
    try {
      await api("/config/groups", { method: "POST", body: { id: group.id, patches } })
      toast("已保存")
      render()
    } catch (err) {
      toast(err.message, true)
    }
  })
  $("#btnGroupRemove").addEventListener("click", async () => {
    if (!confirm(`确认清除群 ${group.id} 的覆盖配置？该群将回到继承默认配置。`)) return
    try {
      await api("/config/groups", { method: "POST", body: { id: group.id, remove: true } })
      toast("已清除")
      render()
    } catch (err) {
      toast(err.message, true)
    }
  })
}

function bindGroupInputs(root, scope) {
  if (!state.groupDirty.has(scope)) state.groupDirty.set(scope, new Map())
  const map = state.groupDirty.get(scope)
  $$("[data-path]", root).forEach((el) => {
    el.addEventListener("input", () => {
      const path = JSON.parse(el.dataset.path)
      const type = el.dataset.ftype
      let value
      if (type === "switch") value = el.checked
      else if (type === "number") value = el.value === "" ? 0 : Number(el.value)
      else if (type === "list") value = el.value.split("\n").map((i) => i.trim()).filter(Boolean)
      else value = el.value
      // 群覆盖里的路径自带群号前缀，提交时作为相对路径
      map.set(pathKey(path), { path, value })
    })
  })
}

/* ---------- 帮助菜单 ---------- */

function helpCfgInput(key, value) {
  if (typeof value === "boolean") {
    return `<div class="field"><label class="switch">
      <input type="checkbox" data-cfg="${esc(key)}" data-kind="bool" ${value ? "checked" : ""} />
      <span class="mono">${esc(key)}</span></label></div>`
  }
  if (typeof value === "number") {
    return `<div class="field"><label class="mono">${esc(key)}</label>
      <input class="input" type="number" data-cfg="${esc(key)}" data-kind="num" value="${esc(value)}" /></div>`
  }
  if (typeof value === "string") {
    return `<div class="field"><label class="mono">${esc(key)}</label>
      <input class="input" data-cfg="${esc(key)}" data-kind="str" value="${esc(value)}" /></div>`
  }
  return `<div class="field"><label class="mono">${esc(key)} <span class="badge">JSON</span></label>
    <textarea class="textarea" data-cfg="${esc(key)}" data-kind="json" rows="3">${esc(JSON.stringify(value))}</textarea></div>`
}

async function renderHelp() {
  const data = await api("/help")
  if (!data.available) {
    $("#mainView").innerHTML = `<div class="page-head"><h1>帮助菜单</h1></div>
      <div class="card"><div class="empty">未检测到喵喵插件的帮助配置（plugins/miao-plugin/config/help_default.js）</div></div>`
    return
  }
  state.help = data
  const cfgEntries = Object.entries(data.helpCfg || {})
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>帮助菜单</h1>
      <p>编辑喵喵的 helpCfg 与 helpList，保存后由喵喵自身热加载生效</p>
      <div class="spacer"></div>
      <span class="badge ${data.fromDefault ? "amber" : ""}">${data.fromDefault ? "当前是默认模板" : "用户自定义"}</span>
    </div>

    <div class="card">
      <div class="card-head"><h2>展示设置</h2><div class="sub">helpCfg</div></div>
      ${cfgEntries.length ? `<div class="cfg-groups">${cfgEntries.map(([k, v]) => `<div>${helpCfgInput(k, v)}</div>`).join("")}</div>` : `<div class="empty">没有展示设置项</div>`}
    </div>

    <div class="card">
      <div class="card-head"><h2>帮助条目</h2><div class="sub">分组与条目</div><div class="spacer"></div>
        <button class="btn small" id="btnAddGroup">新增分组</button></div>
      <div id="helpGroups"></div>
    </div>

    <div class="dirty-bar" style="display:flex">
      <span class="small muted">保存会覆盖 plugins/miao-plugin/config/help.js，原文件备份到 data/panel_backup/</span>
      <div style="flex:1"></div>
      <button class="btn primary" id="btnSaveHelp">${icon("save")}保存帮助菜单</button>
    </div>`

  renderHelpGroups(data.helpList || [])
  $("#btnAddGroup").addEventListener("click", () => {
    const list = collectHelpList()
    list.push({ group: "新分组", list: [] })
    renderHelpGroups(list)
  })
  $("#btnSaveHelp").addEventListener("click", async () => {
    const helpCfg = {}
    let badKey = ""
    $$("[data-cfg]").forEach((el) => {
      const kind = el.dataset.kind
      if (kind === "json") {
        try {
          helpCfg[el.dataset.cfg] = JSON.parse(el.value)
        } catch {
          badKey = el.dataset.cfg
        }
        return
      }
      if (kind === "bool") helpCfg[el.dataset.cfg] = el.checked
      else if (kind === "num") helpCfg[el.dataset.cfg] = Number(el.value) || 0
      else helpCfg[el.dataset.cfg] = el.value
    })
    if (badKey) return toast(`${badKey} 不是合法 JSON`, true)
    try {
      await api("/help", { method: "POST", body: { helpCfg, helpList: collectHelpList() } })
      toast("帮助菜单已保存")
      render()
    } catch (err) {
      toast(err.message, true)
    }
  })
}

function renderHelpGroups(list) {
  const root = $("#helpGroups")
  if (!root) return
  root.innerHTML = list
    .map(
      (group, gi) => `<div class="cfg-group" data-group="${gi}" style="margin-bottom:12px">
      <div class="hd" style="display:flex;gap:8px;align-items:center">
        <input class="input" data-role="group" value="${esc(group.group || "")}" style="max-width:220px" />
        <div style="flex:1"></div>
        <button class="btn small" data-role="add-item">新增条目</button>
        <button class="btn small danger" data-role="remove-group">删除分组</button>
      </div>
      <div class="bd">
        ${(group.list || [])
          .map(
            (item, ii) => `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px" data-item="${ii}">
            <input class="input" data-role="title" value="${esc(item.title || "")}" placeholder="条目" style="max-width:220px" />
            <input class="input" data-role="desc" value="${esc(item.desc || "")}" placeholder="说明" />
            <button class="btn small danger" data-role="remove-item">删除</button>
          </div>`,
          )
          .join("") || `<div class="small muted">该分组下没有条目</div>`}
      </div>
    </div>`,
    )
    .join("") || `<div class="empty">没有帮助分组</div>`

  $$("[data-role='add-item']", root).forEach((btn) =>
    btn.addEventListener("click", () => {
      const list2 = collectHelpList()
      const gi = Number(btn.closest("[data-group]").dataset.group)
      list2[gi].list.push({ title: "", desc: "" })
      renderHelpGroups(list2)
    }),
  )
  $$("[data-role='remove-group']", root).forEach((btn) =>
    btn.addEventListener("click", () => {
      const list2 = collectHelpList()
      list2.splice(Number(btn.closest("[data-group]").dataset.group), 1)
      renderHelpGroups(list2)
    }),
  )
  $$("[data-role='remove-item']", root).forEach((btn) =>
    btn.addEventListener("click", () => {
      const list2 = collectHelpList()
      const groupEl = btn.closest("[data-group]")
      list2[Number(groupEl.dataset.group)].list.splice(Number(btn.closest("[data-item]").dataset.item), 1)
      renderHelpGroups(list2)
    }),
  )
}

function collectHelpList() {
  const root = $("#helpGroups")
  if (!root) return []
  return $$("[data-group]", root).map((groupEl) => ({
    group: $("[data-role='group']", groupEl)?.value || "",
    list: $$("[data-item]", groupEl).map((itemEl) => ({
      title: $("[data-role='title']", itemEl)?.value || "",
      desc: $("[data-role='desc']", itemEl)?.value || "",
    })),
  }))
}

/* ---------- 运行日志 ---------- */

function logLinesHTML(lines) {
  if (!lines?.length) return `<div class="empty">没有匹配的日志行</div>`
  return lines
    .map((line) => {
      const level = (line.match(/\[(error|warn|mark|info|debug)\]/i)?.[1] || "").toLowerCase()
      return `<div class="lv-${level}">${esc(line)}</div>`
    })
    .join("")
}

async function refreshLogLines() {
  if (state.page !== "logs") return
  try {
    const data = await api(
      `/logs?file=${encodeURIComponent(state.logs.file || "")}&level=${encodeURIComponent(state.logs.level || "")}&limit=400`,
    )
    const root = $("#logLines")
    if (root) root.innerHTML = logLinesHTML(data.lines)
  } catch {}
}

async function renderLogs() {
  const files = (await api("/logs/list")).files || []
  const data = await api(
    `/logs?file=${encodeURIComponent(state.logs.file || files[0]?.name || "")}&level=${encodeURIComponent(state.logs.level || "")}&limit=400`,
  )
  state.logs.file = data.file || state.logs.file

  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>运行日志</h1>
      <p>读取 logs/ 目录下的日志文件尾部，最多 400 行</p>
      <div class="spacer"></div>
      <label class="switch"><input type="checkbox" id="logAuto" ${state.logs.auto ? "checked" : ""} /><span class="small">每 5 秒自动刷新</span></label>
      <button class="btn small" id="btnLogRefresh">${icon("refresh")}刷新</button>
    </div>
    <div class="card">
      <div class="card-head">
        <select class="select" id="logFile" style="max-width:280px">
          ${files.map((f) => `<option value="${esc(f.name)}" ${f.name === state.logs.file ? "selected" : ""}>${esc(f.name)}（${fmtBytes(f.size)}）</option>`).join("")}
        </select>
        <select class="select" id="logLevel" style="max-width:180px">
          ${[
            ["", "全部级别"],
            ["error", "error"],
            ["warn", "warn"],
            ["mark", "mark"],
            ["info", "info"],
            ["debug", "debug"],
          ]
            .map(([v, label]) => `<option value="${v}" ${v === state.logs.level ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
        <div class="spacer"></div>
        <span class="small muted">共 ${data.total || 0} 行，显示末尾 ${data.lines?.length || 0} 行</span>
      </div>
      <div class="log-lines" id="logLines">${logLinesHTML(data.lines)}</div>
    </div>`

  $("#btnLogRefresh").addEventListener("click", () => render())
  $("#logFile").addEventListener("change", (e) => {
    state.logs.file = e.target.value
    render()
  })
  $("#logLevel").addEventListener("change", (e) => {
    state.logs.level = e.target.value
    render()
  })
  $("#logAuto").addEventListener("change", (e) => {
    state.logs.auto = e.target.checked
    clearInterval(state.logsTimer)
    state.logsTimer = null
    if (state.logs.auto) state.logsTimer = setInterval(refreshLogLines, 5000)
  })

  clearInterval(state.logsTimer)
  state.logsTimer = state.logs.auto ? setInterval(refreshLogLines, 5000) : null
}

/* ---------- 面板账号 ---------- */

async function renderAccount() {
  const data = state.status || (await loadStatus())
  $("#mainView").innerHTML = `
    <div class="page-head"><h1>面板账号</h1><p>面板密码与收录台账、插件操作权限绑定</p></div>
    <div class="grid c2">
      <div class="card">
        <div class="card-head"><h2>修改密码</h2></div>
        <div class="field"><label>原密码</label><input class="input" type="password" id="pwOld" /></div>
        <div class="field"><label>新密码（至少 8 位）</label><input class="input" type="password" id="pwNew" /></div>
        <div class="field"><label>确认新密码</label><input class="input" type="password" id="pwConfirm" /></div>
        <button class="btn primary" id="btnChangePw">保存新密码</button>
      </div>
      <div class="card">
        <div class="card-head"><h2>运行信息</h2></div>
        <div class="kv">
          <div><span>本体版本</span><span>${esc(data.version || "-")}</span></div>
          <div><span>登录态有效期</span><span>${esc(fmtDuration((await api("/me")).expire - Date.now() / 1000))}</span></div>
          <div><span>在线账号</span><span>${esc(data.snapshot.accounts.join(" / ") || "-")}</span></div>
          <div><span>已安装插件</span><span>${data.plugins.total} 个</span></div>
          <div><span>台账条目</span><span>${data.ledgerItems} 条</span></div>
          <div><span>系统</span><span>${esc(data.snapshot.system.platform)}</span></div>
        </div>
        <div style="margin-top:16px;display:flex;gap:8px">
          <button class="btn" id="btnRestart">${icon("play")}重启本体</button>
          <button class="btn danger" id="btnLogout">退出登录</button>
        </div>
      </div>
    </div>`

  $("#btnChangePw").addEventListener("click", async () => {
    const oldPassword = $("#pwOld").value
    const password = $("#pwNew").value
    if (password.length < 8) return toast("密码长度至少 8 位", true)
    if (password !== $("#pwConfirm").value) return toast("两次输入的新密码不一致", true)
    try {
      const res = await api("/password", { method: "POST", body: { oldPassword, password } })
      if (res.token) {
        state.token = res.token
        localStorage.setItem("fmc-token", state.token)
      }
      toast("密码已更新")
      $("#pwOld").value = $("#pwNew").value = $("#pwConfirm").value = ""
    } catch (err) {
      toast(err.message, true)
    }
  })

  $("#btnRestart").addEventListener("click", async () => {
    if (!confirm("确认重启本体？未保存的运行状态会丢失，重启期间机器人短暂离线。")) return
    try {
      await api("/restart", { method: "POST", body: {} })
      toast("已触发重启，等待重新连接")
    } catch (err) {
      toast(err.message, true)
    }
  })

  $("#btnLogout").addEventListener("click", () => logout())
}

/* ---------- 启动 ---------- */

$("#authForm").addEventListener("submit", submitAuth)
$("#btnRefresh").addEventListener("click", () => {
  loadStatus().catch((err) => toast(err.message, true))
  render()
})
$("#btnAccount").addEventListener("click", () => go("account"))

checkAuth()
