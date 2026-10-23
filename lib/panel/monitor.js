import os from "node:os"
import fs from "node:fs"
import path from "node:path"

/**
 * 资源采样器
 *
 * 每 10 秒采集一次 CPU / 内存 / SWAP / 磁盘占用与读写 / 网络上下行 / Redis 指标，
 * 除最新快照外按三级粒度留历史：10 秒点保留 2 小时、1 分钟点保留 24 小时、
 * 1 小时点保留 31 天。前端按时间范围取聚合后的定长序列（约 180 点），避免把原始
 * 采样点直接铺给浏览器。
 *
 * Linux 走 /proc 读取 SWAP、磁盘 IO、网卡计数；其它平台对应字段返回 null，
 * 由前端标注为不可采集，不用 0 冒充真实值。
 */

const SAMPLE_MS = 10 * 1000
const RAW_MAX = 720 // 10s × 720 = 2h
const MIN_MAX = 1440 // 1min × 1440 = 24h
const HOUR_MAX = 744 // 1h × 744 = 31d

// 时间范围 → 数据源与抽稀步长（步长按约 180 个点反算）
const RANGES = {
  "30m": { source: "raw", step: 1, span: 30 * 60 * 1000 },
  "6h": { source: "min", step: 2, span: 6 * 3600 * 1000 },
  "12h": { source: "min", step: 4, span: 12 * 3600 * 1000 },
  "1d": { source: "min", step: 8, span: 24 * 3600 * 1000 },
  "1w": { source: "hour", step: 1, span: 7 * 24 * 3600 * 1000 },
  "1m": { source: "hour", step: 4, span: 31 * 24 * 3600 * 1000 },
}

const raw = []
const min = []
const hour = []

let cpuPrev = null
let diskPrev = null
let netPrev = null
let lastSample = null
let latestRedis = null
let redisAt = 0
let timer = null
let messageCount = 0
let messagePerSample = 0
let statDay = dayKey()

function dayKey() {
  return new Date().toISOString().slice(0, 10)
}

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function readProc(file) {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/** CPU 使用率：os.cpus() 的累计时间片差值，避免 loadavg 在不同平台语义不同 */
function cpuPercent() {
  const cpus = os.cpus() || []
  if (!cpus.length) return 0
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  if (!cpuPrev) {
    cpuPrev = { idle, total }
    return 0
  }
  const idleDiff = idle - cpuPrev.idle
  const totalDiff = total - cpuPrev.total
  cpuPrev = { idle, total }
  if (totalDiff <= 0) return 0
  return Math.min(100, Math.max(0, (1 - idleDiff / totalDiff) * 100))
}

function swapInfo() {
  const text = readProc("/proc/meminfo")
  if (!text) return null
  const get = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"))
    return m ? num(m[1]) * 1024 : 0
  }
  const total = get("SwapTotal")
  const free = get("SwapFree")
  if (!total) return { total: 0, used: 0, free: 0 }
  return { total, used: total - free, free }
}

/** 磁盘读写累计扇区数（/proc/diskstats，扇区按 512 字节折算） */
function diskIOCounter() {
  const text = readProc("/proc/diskstats")
  if (!text) return null
  let readBytes = 0
  let writeBytes = 0
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 10) continue
    const name = parts[2]
    if (!/^(sd|hd|vd|nvme|mmcblk|dm-|md)/.test(name)) continue
    if (/^(loop|ram|zram)/.test(name)) continue
    readBytes += num(parts[5]) * 512
    writeBytes += num(parts[9]) * 512
  }
  return { readBytes, writeBytes }
}

/** 网卡收发累计字节（/proc/net/dev，排除回环） */
function netCounter() {
  const text = readProc("/proc/net/dev")
  if (!text) return null
  let rx = 0
  let tx = 0
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([^:]+):\s*(.*)$/)
    if (!m) continue
    const name = m[1].trim()
    if (name === "lo") continue
    const cols = m[2].trim().split(/\s+/)
    if (cols.length < 9) continue
    rx += num(cols[0])
    tx += num(cols[8])
  }
  return { rx, tx }
}

function diskUsage(target) {
  try {
    const st = fs.statfsSync(target)
    const total = num(st.blocks) * num(st.bsize)
    const free = num(st.bavail) * num(st.bsize)
    if (!total) return null
    return { total, used: total - free, free, percent: ((total - free) / total) * 100 }
  } catch {
    return null
  }
}

/** 磁盘分区：系统盘 / 数据目录 / 素材缓存；同一分区的多个位置合并成一条 */
function diskList() {
  const root = process.platform === "win32" ? path.parse(process.cwd()).root : "/"
  const candidates = [
    { label: "系统盘", target: root },
    { label: "数据目录", target: path.resolve("data") },
    { label: "素材缓存", target: path.resolve("resources/img") },
  ]
  const list = []
  for (const item of candidates) {
    if (!fs.existsSync(item.target)) {
      if (item.label !== "素材缓存") continue
      item.target = path.resolve("resources")
      if (!fs.existsSync(item.target)) continue
    }
    const usage = diskUsage(item.target)
    if (!usage) continue
    // 同一分区的 total/free 完全一致，合并后并列出覆盖的位置
    const same = list.find((i) => i.total === usage.total && i.free === usage.free)
    if (same) {
      same.labels.push(item.label)
      same.targets.push(item.target)
      continue
    }
    list.push({ label: item.label, labels: [item.label], path: item.target, targets: [item.target], ...usage })
  }
  return list
}

/** Redis 指标：INFO 解析，失败时回退到 PING */
async function redisStats() {
  if (Date.now() - redisAt < 9000) return latestRedis
  redisAt = Date.now()
  const client = global.redis
  if (!client?.isReady) {
    latestRedis = null
    return null
  }
  try {
    // redis v4：优先走内置 info()；sendCommand 对 INFO 的回包在不同版本可能是字符串或 Buffer，统一转字符串再解析
    let info = ""
    try {
      const r = await client.info()
      info = Buffer.isBuffer(r) ? r.toString("utf8") : String(r ?? "")
    } catch {}
    if (!info.includes("redis_version")) {
      try {
        const r = await client.sendCommand(["INFO"])
        info = Buffer.isBuffer(r) ? r.toString("utf8") : String(r ?? "")
      } catch {}
    }
    const map = {}
    for (const line of info.split("\n")) {
      // INFO 回包是 \r\n 行尾，先去 \r 再匹配，否则 $ 匹配失败整行丢弃
      const m = line.trim().match(/^([^:#]+):(.+)$/)
      if (m) map[m[1].trim()] = m[2].trim()
    }
    const db0 = map["db0"] || ""
    const kv = {}
    for (const part of db0.split(",")) {
      const m = part.match(/(\w+)=(\d+)/)
      if (m) kv[m[1]] = num(m[2])
    }
    latestRedis = {
      version: map["redis_version"] || "未知",
      clients: num(map["connected_clients"]),
      totalConnections: num(map["total_connections_received"]),
      totalCommands: num(map["total_commands_processed"]),
      keys: kv.keys ?? 0,
      expires: kv.expires ?? 0,
      avgTtl: kv.avg_ttl ?? 0,
      hits: num(map["keyspace_hits"]),
      misses: num(map["keyspace_misses"]),
      usedMemory: num(map["used_memory"]),
      usedMemoryHuman: map["used_memory_human"] || "",
      uptime: num(map["uptime_in_seconds"]),
    }
  } catch {
    latestRedis = null
  }
  return latestRedis
}

function push(list, point, max) {
  list.push(point)
  while (list.length > max) list.shift()
}

function sampleMessages() {
  if (dayKey() !== statDay) {
    statDay = dayKey()
    messageCount = 0
  }
  const value = messagePerSample
  messagePerSample = 0
  messageCount += value
  return value
}

/** 采集一次；rate 字段是"每秒"速率，首次采集无前值时记为 0 */
async function sample() {
  const memTotal = os.totalmem()
  const memFree = os.freemem()
  const swap = swapInfo()
  const disk = diskIOCounter()
  const net = netCounter()
  const now = Date.now()
  const dt = lastSample ? Math.max(1, now - lastSample.t) / 1000 : 0

  let diskRead = null
  let diskWrite = null
  if (disk) {
    if (diskPrev && dt) {
      diskRead = Math.max(0, (disk.readBytes - diskPrev.readBytes) / dt)
      diskWrite = Math.max(0, (disk.writeBytes - diskPrev.writeBytes) / dt)
    } else {
      diskRead = 0
      diskWrite = 0
    }
    diskPrev = disk
  }

  let netRx = null
  let netTx = null
  if (net) {
    if (netPrev && dt) {
      netRx = Math.max(0, (net.rx - netPrev.rx) / dt)
      netTx = Math.max(0, (net.tx - netPrev.tx) / dt)
    } else {
      netRx = 0
      netTx = 0
    }
    netPrev = net
  }

  const point = {
    t: now,
    cpu: Number(cpuPercent().toFixed(2)),
    memUsed: memTotal - memFree,
    memTotal,
    swapUsed: swap ? swap.used : null,
    swapTotal: swap ? swap.total : null,
    diskRead,
    diskWrite,
    netRx,
    netTx,
    msgs: sampleMessages(),
  }

  push(raw, point, RAW_MAX)
  lastSample = point

  // 分钟点：取最近 6 个 10 秒点的均值，跨分钟边界时落一次
  const bucket = Math.floor(point.t / 60000) * 60000
  if (!min.length || min[min.length - 1].t < bucket) {
    push(min, { ...point, t: bucket, msgs: sumMsgs(raw, 60000) }, MIN_MAX)
  } else {
    min[min.length - 1] = { ...point, t: bucket, msgs: sumMsgs(raw, 60000) }
  }

  const hourBucket = Math.floor(point.t / 3600000) * 3600000
  if (!hour.length || hour[hour.length - 1].t < hourBucket) {
    push(hour, { ...point, t: hourBucket, msgs: sumMsgs(raw, 3600000) }, HOUR_MAX)
  } else {
    hour[hour.length - 1] = { ...point, t: hourBucket, msgs: sumMsgs(raw, 3600000) }
  }

  await redisStats()
  return point
}

function sumMsgs(list, span) {
  const since = Date.now() - span
  let total = 0
  for (const item of list) if (item.t >= since) total += num(item.msgs)
  return total
}

/** 按范围取序列：返回定长点集，附带范围与粒度的可读标签 */
export function series(range = "30m") {
  const conf = RANGES[range] || RANGES["30m"]
  const source = conf.source === "min" ? min : conf.source === "hour" ? hour : raw
  const since = Date.now() - conf.span
  const picked = []
  let index = 0
  for (const item of source) {
    if (item.t < since) {
      index++
      continue
    }
    if (index++ % conf.step === 0) picked.push(item)
  }
  if (picked.length < 2 && lastSample) picked.push(lastSample)
  return {
    range,
    span: conf.span,
    points: picked.map((i) => ({
      t: i.t,
      cpu: i.cpu,
      mem: i.memTotal ? (i.memUsed / i.memTotal) * 100 : 0,
      memUsed: i.memUsed,
      diskRead: i.diskRead,
      diskWrite: i.diskWrite,
      netRx: i.netRx,
      netTx: i.netTx,
      msgs: num(i.msgs),
    })),
  }
}

/** 首页/监控页顶部需要的即时快照 */
export async function snapshot() {
  const memTotal = os.totalmem()
  const memFree = os.freemem()
  const swap = swapInfo()
  const io = diskIOCounter()
  const net = netCounter()
  const redis = await redisStats()
  const Bot = global.Bot
  return {
    t: Date.now(),
    uptime: process.uptime(),
    botUptime: Bot?.stat?.start_time ? Date.now() / 1000 - Bot.stat.start_time : 0,
    online: Bot?.stat?.online === 2,
    accounts: (Bot?.uin || []).map(String),
    groups: Bot?.getGroupList?.()?.length || 0,
    msgsToday: messageCount,
    cpu: Number(cpuPercent().toFixed(1)),
    memUsed: memTotal - memFree,
    memTotal,
    memPercent: memTotal ? ((memTotal - memFree) / memTotal) * 100 : 0,
    swap,
    disk: diskList(),
    diskIO:
      lastSample && lastSample.diskRead !== null
        ? { read: lastSample.diskRead, write: lastSample.diskWrite }
        : null,
    diskSupported: !!io,
    net:
      lastSample && lastSample.netRx !== null
        ? { rx: lastSample.netRx, tx: lastSample.netTx }
        : null,
    netSupported: !!net,
    redis,
    // Windows 的 os.loadavg() 恒为 [0,0,0]，没有语义，按不可采集处理
    load: process.platform === "win32" ? null : os.loadavg().map((i) => Number(i.toFixed(2))),
    system: {
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpuModel: (os.cpus()[0] || {}).model || "",
      cpuCount: os.cpus().length,
      node: process.version,
      hostname: os.hostname(),
      totalMem: memTotal,
    },
  }
}

/** 订阅：每次采样后推送最新点，供 WebSocket 使用 */
const listeners = new Set()

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function latest() {
  return lastSample
}

export function start() {
  if (timer) return
  const tick = async () => {
    try {
      const point = await sample()
      for (const fn of listeners) {
        try {
          fn(point)
        } catch {}
      }
    } catch (err) {
      global.logger?.error?.("[面板] 采样失败", err)
    }
  }
  tick()
  timer = setInterval(tick, SAMPLE_MS)
  if (timer.unref) timer.unref()
}

/** 挂载消息计数：只统计到达 Bot 的消息事件，不改变原有事件分发 */
export function bindBot(Bot) {
  if (!Bot?.on) return
  Bot.on("message", () => {
    messagePerSample++
  })
}
