import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import test, { after, before } from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const authUrl = new URL("../lib/panel/auth.js", import.meta.url)
const tempParent = path.join(root, "temp")
let suiteRoot

before(() => {
  fs.mkdirSync(tempParent, { recursive: true })
  suiteRoot = fs.mkdtempSync(path.join(tempParent, "panel-auth-regression-"))
})

after(() => {
  if (suiteRoot) fs.rmSync(suiteRoot, { recursive: true, force: true })
})

function runScenario(name, body) {
  const cwd = fs.mkdtempSync(path.join(suiteRoot, `${name}-`))
  const script = [
    'import assert from "node:assert/strict"',
    'import crypto from "node:crypto"',
    'import fs from "node:fs"',
    'import path from "node:path"',
    `import * as auth from ${JSON.stringify(authUrl.href)}`,
    "const decode = token => {",
    "  const [header, body] = token.split('.')",
    "  return {",
    "    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),",
    "    payload: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),",
    "  }",
    "}",
    "",
    body,
    "",
  ].join("\n")

  try {
    return execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd,
      encoding: "utf8",
      timeout: 20000,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    error.message += `\nPanel auth scenario: ${name}\nstdout:\n${error.stdout || ""}\nstderr:\n${error.stderr || ""}`
    throw error
  }
}

const JWT_HELPERS = `
function sign(header, payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url")
  const data = \`\${encode(header)}.\${encode(payload)}\`
  const secret = fs.readFileSync(path.join(auth.panelDir(), "secret.key"), "utf8").trim()
  const signature = crypto.createHmac("sha256", secret).update(data).digest("base64url")
  return \`\${data}.\${signature}\`
}
function invalid(token, label) {
  assert.equal(auth.verifyToken(token), null, label)
}
`

test("scrypt accepts the correct password, rejects wrong passwords, and never stores plaintext", () => {
  runScenario("password", `
    const password = "correct horse battery staple"
    assert.equal(auth.isInitialized(), false)
    assert.equal(auth.verifyPassword(password), false)
    auth.setPassword(password)
    assert.equal(auth.isInitialized(), true)
    assert.equal(auth.panelDir(), path.resolve("data/panel"))

    const authFile = path.join(auth.panelDir(), "auth.json")
    const raw = fs.readFileSync(authFile, "utf8")
    const stored = JSON.parse(raw)
    assert.match(stored.salt, /^[a-f0-9]{32}$/)
    assert.match(stored.hash, /^[a-f0-9]{128}$/)
    assert.equal(raw.includes(password), false)
    assert.equal(raw.includes(Buffer.from(password).toString("base64")), false)
    assert.equal(auth.verifyPassword(password), true)
    assert.equal(auth.verifyPassword("wrong password"), false)
    assert.equal(auth.verifyPassword(\`\${password} \`), false)
    assert.equal(auth.verifyPassword(""), false)
    assert.equal(auth.verifyPassword(undefined), false)
    assert.equal(fs.readFileSync(authFile, "utf8"), raw)

    auth.setPassword("replacement-password")
    assert.equal(auth.verifyPassword(password), false)
    assert.equal(auth.verifyPassword("replacement-password"), true)
    assert.equal(fs.readFileSync(authFile, "utf8").includes("replacement-password"), false)
  `)
})

test("JWT HS256 roundtrip carries panel scope and the requested expiration", () => {
  runScenario("jwt-roundtrip", `
    const before = Math.floor(Date.now() / 1000)
    const token = auth.issueToken(120)
    assert.equal(token.split(".").length, 3)
    const { header, payload } = decode(token)
    assert.deepEqual(header, { alg: "HS256", typ: "JWT" })
    assert.equal(payload.scope, "panel")
    assert.equal(payload.exp - payload.iat, 120)
    assert.ok(payload.iat >= before && payload.iat <= Math.floor(Date.now() / 1000))
    assert.deepEqual(auth.verifyToken(token), payload)

    const secret = fs.readFileSync(path.join(auth.panelDir(), "secret.key"), "utf8").trim()
    assert.match(secret, /^[a-f0-9]{64}$/)
    const [headerPart, bodyPart] = token.split(".")
    const expected = crypto.createHmac("sha256", secret).update(\`\${headerPart}.\${bodyPart}\`).digest("base64url")
    assert.equal(token.split(".")[2], expected)
    const firstDefault = decode(auth.issueToken()).payload
    const secondDefault = decode(auth.issueToken()).payload
    assert.equal(firstDefault.scope, "panel")
    assert.equal(secondDefault.scope, "panel")
    assert.equal(firstDefault.exp - firstDefault.iat, 43200)
    assert.equal(secondDefault.exp - secondDefault.iat, 43200)
    assert.equal(auth.verifyToken(auth.issueToken()).scope, "panel")
  `)
})

test("JWT rejects a tampered signature, body, wrong algorithm, wrong scope, and expiration", () => {
  runScenario("jwt-rejections", `
    ${JWT_HELPERS}
    const token = auth.issueToken(120)
    const { header, payload } = decode(token)
    const [headerPart, bodyPart, signature] = token.split(".")
    const tamperedSignature = \`\${signature[0] === "A" ? "B" : "A"}\${signature.slice(1)}\`
    assert.equal(auth.verifyToken(\`\${headerPart}.\${bodyPart}.\${tamperedSignature}\`), null)
    assert.equal(auth.verifyToken(\`\${headerPart}.\${bodyPart}.\`), null)
    assert.equal(auth.verifyToken(\`\${headerPart}.\${bodyPart}.not-a-signature\`), null)
    assert.equal(auth.verifyToken(\`\${headerPart}.\${Buffer.from(JSON.stringify({ ...payload, scope: "admin" })).toString("base64url")}.\${signature}\`), null)
    assert.equal(auth.verifyToken(sign({ ...header, alg: "none" }, payload)), null)
    assert.equal(auth.verifyToken(sign({ ...header, alg: "HS512" }, payload)), null)
    assert.deepEqual(auth.verifyToken(sign(header, payload)), payload)
    assert.equal(auth.verifyToken(sign(header, { ...payload, scope: "admin" })), null)
    assert.equal(auth.verifyToken(sign(header, { ...payload, exp: Math.floor(Date.now() / 1000) - 1 })), null)
    const exactSecond = Math.floor(Date.now() / 1000) * 1000
    const realNow = Date.now
    Date.now = () => exactSecond + 1
    invalid(sign(header, { ...payload, exp: exactSecond / 1000 }), "one millisecond past expiration")
    Date.now = realNow
    assert.equal(auth.verifyToken(sign(header, { scope: "panel", iat: payload.iat })), null)
    assert.equal(auth.verifyToken("not-a-jwt"), null)
    assert.equal(auth.verifyToken(auth.issueToken(120) + ".extra"), null)
    assert.equal(auth.verifyToken(""), null)
    assert.equal(auth.verifyToken(null), null)
  `)
})

test("JWT TTL has a minimum of 60 seconds for undersized or invalid values", () => {
  runScenario("jwt-ttl", `
    for (const ttl of [undefined, null, 0, -1, 1, 59, 60, NaN, Infinity, "invalid", "90"]) {
      const { payload } = decode(auth.issueToken(ttl))
      const ttlSeconds = payload.exp - payload.iat
      assert.ok(ttlSeconds >= 60, \`TTL must be at least 60 seconds: \${String(ttl)} (received \${String(ttlSeconds)})\`)
      assert.ok(Number.isFinite(ttlSeconds) && Number.isInteger(ttlSeconds), \`TTL must be a finite integer: \${String(ttl)}\`)
    }
    assert.equal(decode(auth.issueToken(59)).payload.exp - decode(auth.issueToken(59)).payload.iat, 60)
    assert.equal(decode(auth.issueToken(0)).payload.exp - decode(auth.issueToken(0)).payload.iat, 60)
    assert.equal(decode(auth.issueToken("90")).payload.exp - decode(auth.issueToken("90")).payload.iat, 90)
    assert.equal(auth.verifyToken(auth.issueToken(60)).scope, "panel")
  `)
})

test("Bearer authentication takes precedence over a query token", () => {
  runScenario("token-source", `
    const bearer = auth.issueToken(120)
    const query = auth.issueToken(240)
    assert.equal(auth.tokenFromRequest({ headers: { authorization: "Bearer invalid" }, query: { token: query } }), "invalid")
    assert.equal(auth.verifyToken(auth.tokenFromRequest({ headers: { authorization: "Bearer invalid" }, query: { token: query } })), null)
    assert.equal(auth.tokenFromRequest({ headers: { authorization: "bearer lowercase" }, query: { token: query } }), query)
    assert.equal(auth.tokenFromRequest({ headers: {}, query: { token: query } }), query)
    assert.equal(auth.tokenFromRequest({ headers: { authorization: "Bearer " }, query: { token: query } }), "")
    assert.equal(auth.tokenFromRequest({ headers: { authorization: "Basic credentials" }, query: {} }), "")
    assert.equal(auth.tokenFromRequest({}), "")
    assert.equal(auth.verifyToken(auth.tokenFromRequest({ headers: { authorization: \`Bearer \${bearer}\` }, query: { token: query } })).scope, "panel")
  `)
})

test("login lockout uses socket.remoteAddress and changing X-Forwarded-For cannot bypass it", () => {
  runScenario("rate-limit", `
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    const req = (xff) => ({
      socket: { remoteAddress: "198.51.100.7" },
      ip: "192.0.2.99",
      headers: xff ? { "x-forwarded-for": xff } : {},
    })
    assert.equal(auth.loginLocked(req("203.0.113.1"), 3), 0)
    for (let index = 0; index < 2; index++) {
      auth.recordFail(req(\`203.0.113.\${index + 1}\`))
      assert.equal(auth.loginLocked(req(\`203.0.113.\${index + 20}\`), 3), 0)
    }
    auth.recordFail(req("203.0.113.3"))
    assert.ok(auth.loginLocked(req("203.0.113.250"), 3) > 0)
    assert.ok(auth.loginLocked({ socket: { remoteAddress: "198.51.100.7" }, headers: { "x-forwarded-for": "203.0.113.251, 198.51.100.7" } }, 3) > 0)
    assert.equal(auth.loginLocked(req("203.0.113.252"), 4), 0)
    assert.equal(auth.loginLocked({ socket: { remoteAddress: "198.51.100.8" }, headers: { "x-forwarded-for": "203.0.113.253" } }, 3), 0)

    auth.clearFail(req("203.0.113.254"))
    assert.equal(auth.loginLocked(req("203.0.113.255"), 3), 0)
    auth.recordFail(req("203.0.113.256"))
    assert.equal(auth.loginLocked(req("203.0.113.257"), 3), 0)
    assert.ok(auth.loginLocked(req("203.0.113.258"), 1) > 0)
    now += 10 * 60 * 1000 + 1000
    assert.equal(auth.loginLocked(req("203.0.113.259"), 1), 0)
    Date.now = realNow
  `)
})
