import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * 面板登录鉴权
 *
 * 密码以 scrypt 派生后存 data/panel/auth.json（不存明文）；登录态用 HS256
 * JWT 自签自验，签名密钥随机生成后保存在 data/panel/secret.key，不依赖外部
 * 依赖库，也不与本体 config/server.yaml 的 HTTP 鉴权混用。
 * 登录失败按来源 IP 计数，超过配置上限后暂时拒绝，避免在线爆破。
 */

const DIR = path.resolve("data/panel")
const AUTH_FILE = path.join(DIR, "auth.json")
const SECRET_FILE = path.join(DIR, "secret.key")
const FAIL_WINDOW = 10 * 60 * 1000
const KEY_LEN = 64

const fails = new Map()

export function panelDir() {
  return DIR
}

export function isInitialized() {
  try {
    return fs.existsSync(AUTH_FILE)
  } catch {
    return false
  }
}

function readAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"))
  } catch {
    return null
  }
}

export function setPassword(password) {
  const pw = String(password || "")
  const salt = crypto.randomBytes(16).toString("hex")
  const hash = crypto.scryptSync(pw, salt, KEY_LEN).toString("hex")
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify({ salt, hash, updatedAt: new Date().toISOString() }, null, 2),
  )
  try {
    fs.chmodSync(AUTH_FILE, 0o600)
  } catch {}
}

export function verifyPassword(password) {
  const auth = readAuth()
  if (!auth?.salt || !auth?.hash) return false
  const hash = crypto.scryptSync(String(password || ""), auth.salt, KEY_LEN)
  const expect = Buffer.from(auth.hash, "hex")
  if (hash.length !== expect.length) return false
  return crypto.timingSafeEqual(hash, expect)
}

function secret() {
  fs.mkdirSync(DIR, { recursive: true })
  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 })
  }
  return fs.readFileSync(SECRET_FILE, "utf8").trim()
}

function b64url(input) {
  return Buffer.from(input).toString("base64url")
}

/** 签发登录态：payload 仅放用途标识，过期时间由 ttl 决定 */
export function issueToken(ttl = 43200) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64url(JSON.stringify({ scope: "panel", iat: now, exp: now + Math.max(60, Number(ttl) || 43200) }))
  const data = `${header}.${body}`
  const sig = crypto.createHmac("sha256", secret()).update(data).digest("base64url")
  return `${data}.${sig}`
}

/** 校验登录态：固定 HS256（不接受 header 声明的其它算法） */
export function verifyToken(token) {
  try {
    const [header, body, sig] = String(token || "").split(".")
    if (!header || !body || !sig) return null
    const expect = crypto.createHmac("sha256", secret()).update(`${header}.${body}`).digest()
    const got = Buffer.from(sig, "base64url")
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null
    const head = JSON.parse(Buffer.from(header, "base64url").toString())
    if (head?.alg !== "HS256") return null
    const payload = JSON.parse(Buffer.from(body, "base64url").toString())
    if (payload?.scope !== "panel") return null
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

/** 从请求中取出登录态：优先 Authorization 头，WebSocket 走查询参数 */
export function tokenFromRequest(req) {
  const auth = req.headers?.authorization || ""
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim()
  return req.query?.token || ""
}

function keyOf(req) {
  return String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || req.ip || "unknown")
    .split(",")[0]
    .trim()
}

/** 登录失败计数：命中上限返回剩余锁定秒数 */
export function loginLocked(req, limit = 5) {
  const item = fails.get(keyOf(req))
  if (!item) return 0
  if (Date.now() - item.firstAt > FAIL_WINDOW) {
    fails.delete(keyOf(req))
    return 0
  }
  if (item.count < Math.max(1, Number(limit) || 5)) return 0
  return Math.ceil((item.firstAt + FAIL_WINDOW - Date.now()) / 1000)
}

export function recordFail(req) {
  const key = keyOf(req)
  const item = fails.get(key)
  if (!item || Date.now() - item.firstAt > FAIL_WINDOW) {
    fails.set(key, { count: 1, firstAt: Date.now() })
    return
  }
  item.count++
}

export function clearFail(req) {
  fails.delete(keyOf(req))
}
