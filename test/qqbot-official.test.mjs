import test from "node:test"
import assert from "node:assert/strict"

/** 官机适配器发送链路自测：不走真机，拦截 request 捕获 body 逐字段断言 */

const logs = []
global.Bot = {
  adapter: [],
  uins: [],
  makeLog: (lv, msg) => logs.push(String(lv)),
  // 模拟 util.Buffer：Buffer 原样返回（与线上对 Buffer 段的行为一致）
  Buffer: data => (Buffer.isBuffer(data) ? data : data),
  Buffer_from: (...args) => Buffer.from(...args),
  // 模拟 util.fileType：要求 {file: ...} 形状（data.file 为 Buffer），形状错即抛错
  fileType: async data => {
    if (!data || !Buffer.isBuffer(data.file)) throw new TypeError("fileType 需要 {file: Buffer}")
    return { type: { ext: "png" } }
  },
  String: data => String(data),
}

const { QQBotOfficialAdapter } = await import("../plugins/adapter/QQBotOfficial.js")

test("图片段应走 file_data 直传，不带 url 字段", async () => {
  const adapter = QQBotOfficialAdapter
  const calls = []
  adapter.request = async (appid, secret, method, api, body) => {
    calls.push({ method, api, body })
    return { file_info: "TEST_FILE_INFO" }
  }

  const image = Buffer.from("fake-png-bytes")
  await adapter.sendMsg("10000", "secret", "user", "OPENID_X", [
    { type: "text", text: "图" },
    { type: "image", file: image },
  ])

  assert.equal(calls.length, 2)
  const [upload, send] = calls

  // 上传请求：JSON body，file_data 为 base64，file_name 必填，不得出现 url
  assert.equal(upload.api, "/v2/users/OPENID_X/files")
  assert.equal(upload.body.file_type, 1)
  assert.equal(upload.body.srv_send_msg, false)
  assert.equal(upload.body.file_data, image.toString("base64"))
  assert.ok(upload.body.file_name, "二进制直传 file_name 必填")
  assert.ok(!("url" in upload.body), "不得携带 url 字段")

  // 发消息请求：msg_type=7 且 media.file_info 为上传返回的字符串
  assert.equal(send.api, "/v2/users/OPENID_X/messages")
  assert.equal(send.body.msg_type, 7)
  assert.equal(send.body.media.file_info, "TEST_FILE_INFO")
})

test("纯文本段应为 msg_type=0 且 content 正确", async () => {
  const adapter = QQBotOfficialAdapter
  let captured = null
  adapter.request = async (appid, secret, method, api, body) => {
    captured = { method, api, body }
    return { id: "MID" }
  }

  await adapter.sendMsg("10000", "secret", "user", "OPENID_Y", [{ type: "text", text: "#帮助" }])

  assert.equal(captured.body.msg_type, 0)
  assert.equal(captured.body.content, "#帮助")
  assert.ok(!("media" in captured.body))
})
