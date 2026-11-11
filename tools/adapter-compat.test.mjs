import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import path from "node:path"
import test from "node:test"
import { segment } from "icqq/lib/message/elements.js"

const root = new URL("../", import.meta.url)
const sources = Object.fromEntries(await Promise.all([
  "lib/bot.js", "plugins/adapter/OneBotv11.js", "plugins/adapter/stdin.js",
].map(async file => [file, await readFile(new URL(file, root), "utf8")])))
const noop = () => {}
const logger = { cyan: String, green: String, magenta: String }

// 只加载真实定义，不导入 bot/config，也不创建 HTTP 或 readline 服务。
function evaluate(file, dependencies, result) {
  const source = sources[file]
    .replace(/^import .*\r?\n/gm, "")
    .replace(/^export \{.*\r?\n/gm, "")
    .replace("export default class", "class")
  return new Function(...Object.keys(dependencies), `${source}\nreturn ${result}`)(...Object.values(dependencies))
}

function coreFixture(accounts = []) {
  const logs = []
  const util = { makeLog: (...args) => logs.push(args), String: JSON.stringify }
  const cfg = { bot: { cache_group_member: false }, checkGroup: () => true }
  const Core = evaluate("lib/bot.js", {
    EventEmitter, util, cfg, segment, installSensitiveOps: noop,
    randomBytes: size => Buffer.alloc(size),
  }, "Yunzai")
  const core = Object.assign(Object.create(Core.prototype), {
    bots: Object.fromEntries(accounts.map(bot => [bot.self_id, bot])),
    uins: accounts.map(bot => bot.self_id), adapter: [],
  })
  EventEmitter.call(core)

  // 只执行生产环境的 Proxy 表达式，不触发 run() 及其启动副作用。
  const source = sources["lib/bot.js"]
  const start = source.indexOf("global.Bot = new Proxy(this, {")
  const end = source.indexOf("    await this.serverLoad()", start)
  assert.ok(start >= 0 && end > start)
  const globals = {}
  new Function("global", "util", source.slice(start, end)).call(core, globals, util)
  return { core, Bot: globals.Bot, cfg, logs }
}

function oneBotFixture() {
  const fixture = coreFixture()
  const adapter = evaluate("plugins/adapter/OneBotv11.js", {
    Bot: fixture.Bot, cfg: fixture.cfg, path, logger, ulid: () => "mock-echo",
  }, "OneBotv11Adapter")
  const calls = []
  // 只有 API 传输被替换，connect、picker 和成员信息仍走生产实现。
  adapter.sendApi = async (data, ws, action, params = {}) => {
    calls.push({ self_id: data.self_id, action, params })
    switch (action) {
      case "get_login_info": return { data: { user_id: data.self_id, nickname: data.self_id } }
      case "get_friend_list":
      case "get_group_list":
      case "get_guild_list": return { data: [] }
      case "get_group_member_info": return { data: { ...params, owner: data.self_id } }
      default: return { data: {}, message_id: "sent" }
    }
  }
  fixture.Bot.Buffer = async file => file
  return { ...fixture, adapter, calls }
}

function account(self_id, friends = [], groups = [], members = []) {
  const sends = []
  const bot = {
    self_id, sends, fl: new Map(friends.map(id => [id, { user_id: id }])),
    gl: new Map(groups.map(id => [id, { group_id: id }])), gml: new Map(members),
    pickFriend(id) { return peer("friend", id) },
    pickGroup(id) { return peer("group", id) },
  }
  function peer(kind, id) {
    return {
      self_id, kind, id, name: `${self_id}:${kind}`,
      sendMsg(...args) { sends.push({ receiver: this, kind, id, args }); return "sent" },
      pickMember(user_id) { return peer("member", user_id) },
    }
  }
  return bot
}

function assertPeer(actual, self_id, id) {
  assert.equal(actual?.self_id, self_id)
  assert.equal(actual.id, id)
}

test("icqq remains unchanged and has no segment.file", () => {
  assert.equal(segment.file, undefined)
  assert.deepEqual(segment.at("123"), {
    type: "at", qq: 0, id: "123", text: undefined, dummy: undefined,
  })
})

for (const kind of ["friend", "group", "member"]) {
  test(`prepareEvent ${kind}.sendFile sends a flat file segment`, () => {
    const bot = account("A")
    const { core } = coreFixture([bot])
    const event = { self_id: "A", user_id: "u", group_id: "g" }
    core.prepareEvent(event)
    const file = Buffer.from("attachment")
    assert.equal(event[kind].sendFile(file, "named.bin"), "sent")
    assert.deepEqual(bot.sends[0].args, [{ type: "file", file, name: "named.bin" }])
    assert.equal(bot.sends[0].receiver, event[kind])
  })
}

test("prepareEvent fills forwarding helpers on the account without replacing native ones", async () => {
  const bot = account("A")
  const { core } = coreFixture([bot])
  const event = { self_id: "A", user_id: "u" }
  core.prepareEvent(event)
  assert.equal(event.bot, bot)
  assert.deepEqual(event.bot.makeForwardMsg([{ message: "one" }]), {
    type: "node", data: [{ message: "one" }],
  })
  assert.deepEqual(event.bot.makeForwardArray([{ message: "one" }], { user_id: "u" }), {
    type: "node", data: [{ user_id: "u", message: { message: "one" } }],
  })
  const sent = []
  assert.deepEqual(await event.bot.sendForwardMsg(msg => {
    sent.push(msg)
    return msg
  }, [{ message: "one" }]), ["one"])
  assert.deepEqual(sent, ["one"])

  const nativeBot = account("B")
  const native = () => "native"
  nativeBot.sendForwardMsg = native
  const second = coreFixture([nativeBot]).core
  const nativeEvent = { self_id: "B", user_id: "u" }
  second.prepareEvent(nativeEvent)
  assert.equal(nativeEvent.bot.sendForwardMsg, native)
})

test("prepareEvent keeps native sendFile", () => {
  const { core } = coreFixture([account("A")])
  const sendFile = () => "native"
  const event = { self_id: "A", friend: { sendFile } }
  core.prepareEvent(event)
  assert.equal(event.friend.sendFile, sendFile)
})

for (const name of [undefined, "custom.bin"]) {
  test(`stdin sendFile reaches real sendMsg with ${name ?? "basename"}`, async () => {
    const writes = [], logs = [], inputs = []
    const Bot = {
      adapter: [], makeLog: (...args) => logs.push(args),
      fileType: async input => {
        inputs.push(input)
        return { buffer: Buffer.from("file"), name: input.name, url: "mock-file" }
      },
      fileToUrl: async () => "mock-url",
    }
    const adapter = evaluate("plugins/adapter/stdin.js", {
      Bot, path, segment, logger,
      fs: { writeFile: async (...args) => writes.push(args) },
      spawn: () => assert.fail("must not spawn"),
    }, "Bot.adapter[0]")
    const result = await adapter.sendFile("/mock/input.bin", name)
    const expectedName = name ?? "input.bin"
    assert.deepEqual(inputs, [{ type: "file", file: "/mock/input.bin", name: expectedName }])
    assert.equal(writes[0][0], `data/stdin/${expectedName}`)
    assert.match(logs[0][1], /mock-file/)
    assert.ok(result.message_id)
  })
}

for (const kind of ["friend", "group"]) {
  test(`flat file bridge reaches OneBot ${kind} upload API`, async () => {
    const { core, Bot, adapter, calls } = oneBotFixture()
    const data = { self_id: "B", user_id: "u", group_id: "g" }
    await adapter.connect(data, {})
    const send = kind === "friend" ? "sendFriendMsg" : "sendGroupMsg"
    const peer = { sendMsg: msg => adapter[send](data, msg) }
    const event = { self_id: "B", [kind]: peer }
    core.prepareEvent(event)
    calls.length = 0
    await event[kind].sendFile("file:///mock/file.bin", "named.bin")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].self_id, "B")
    assert.equal(calls[0].action, kind === "friend" ? "upload_private_file" : "upload_group_file")
    assert.equal(calls[0].params.file, "/mock/file.bin")
    assert.equal(calls[0].params.name, "named.bin")
    assert.equal(Bot.B, data.bot)
  })
}

const atCases = [
  [segment.at("123"), "123"], [segment.at(123), "123"], [segment.at("all"), "all"],
  [segment.at(0), "0"], [segment.at("0"), "0"], [segment.at("00123"), "00123"],
  [segment.at("9007199254740993"), "9007199254740993"], [segment.at("tiny-id"), "tiny-id"],
  [{ type: "at", qq: "direct" }, "direct"], [{ type: "at", qq: 123 }, "123"],
  [{ type: "at", qq: 123, id: 0 }, "0"], [{ type: "at", data: { qq: 0, id: "456" } }, "456"],
  [{ type: "at", data: { qq: "all" } }, "all"],
]
for (const [input, expected] of atCases) {
  test(`OneBot at boundary ${JSON.stringify(input)} -> ${expected}`, async () => {
    const { adapter } = oneBotFixture()
    const [[output]] = await adapter.makeMsg(structuredClone(input))
    assert.equal(output.data.qq, expected)
  })
}

test("channel at preserves tiny ID and sends through channel API", async () => {
  const { adapter, calls } = oneBotFixture()
  const data = { self_id: "B", guild_id: "guild", channel_id: "channel" }
  await adapter.connect(data, {})
  calls.length = 0
  await adapter.sendGuildMsg(data, segment.at("9007199254740993"))
  assert.equal(calls[0].action, "send_guild_channel_msg")
  assert.equal(calls[0].params.message[0].data.qq, "9007199254740993")
  assert.equal(calls[0].params.message[0].data.id, "9007199254740993")
})

for (const self_id of ["A", "B"]) {
  for (const suppliedBot of [true, false]) {
    for (const kind of ["friend", "group"]) {
      for (const quote of [false, true]) {
        test(`reply ${self_id}/${kind} quote=${quote} suppliedBot=${suppliedBot}, ID 0`, () => {
          const bots = [account("A"), account("B")]
          const { core } = coreFixture(bots)
          const bot = bots.find(bot => bot.self_id === self_id)
          const event = { self_id, user_id: "u", message_id: 0 }
          if (kind === "group") event.group_id = "g"
          if (suppliedBot) event.bot = bot
          const input = Object.freeze([Object.freeze({ type: "text", text: "payload" })])
          core.prepareEvent(event)
          assert.equal(event.bot, bot)
          assert.equal(event.reply(input, quote), "sent")
          const sent = bot.sends[0]
          assert.equal(sent.kind, kind)
          assert.equal(sent.receiver, event[kind])
          assert.equal(sent.args.length, 1)
          assert.deepEqual(sent.args[0], quote ? [{ type: "reply", id: 0 }, ...input] : input)
          assert.deepEqual(input, [{ type: "text", text: "payload" }])
          if (quote) assert.notEqual(sent.args[0], input)
          assert.equal(bots.find(other => other !== bot).sends.length, 0)
        })
      }
    }
  }
}

for (const message_id of [undefined, null, "msg-id", "0"]) {
  test(`reply scalar and optional message_id=${message_id}`, () => {
    const bot = account("B")
    const { core } = coreFixture([bot])
    const event = { self_id: "B", user_id: "u", message_id }
    core.prepareEvent(event)
    event.reply("payload", true)
    assert.deepEqual(bot.sends[0].args, [message_id == null ? "payload" : [
      { type: "reply", id: message_id }, "payload",
    ]])
  })
}

test("native reply, peers and input are preserved on both accounts", () => {
  const bots = [account("A"), account("B")]
  const { core } = coreFixture(bots)
  for (const bot of bots) {
    let call
    const input = Object.freeze([Object.freeze({ type: "text", text: "payload" })])
    const reply = function (...args) { call = { receiver: this, args }; return "native" }
    const friend = bot.pickFriend("native-u")
    const group = bot.pickGroup("native-g")
    const event = { self_id: bot.self_id, user_id: "u", group_id: "g", bot, friend, group, reply }
    core.prepareEvent(event)
    assert.equal(event.reply, reply)
    assert.equal(event.friend, friend)
    assert.equal(event.group, group)
    assert.equal(event.reply(input, true), "native")
    assert.equal(call.receiver, event)
    assert.deepEqual(call.args, [input, true])
    assert.equal(bot.sends.length, 0)
  }
})

test("OneBot import installs no preferred-account global shim", () => {
  const { core } = oneBotFixture()
  assert.equal(Object.hasOwn(core.bots, "getGroupMemberInfo"), false)
})

test("connected account member info uses its own API and global Proxy still follows preference", async () => {
  const { core, Bot, adapter, calls } = oneBotFixture()
  await adapter.connect({ self_id: "A" }, {})
  await adapter.connect({ self_id: "B" }, {})
  calls.length = 0
  for (const self_id of ["A", "B"]) {
    const info = await Bot[self_id].getGroupMemberInfo("g", "u")
    assert.equal(info.owner, self_id)
    assert.equal(Bot[self_id].gml.get("g").get("u"), info)
  }
  assert.deepEqual(calls.map(call => call.self_id), ["A", "B"])
  assert.ok(calls.every(call => call.action === "get_group_member_info" && call.params.no_cache === true))
  assert.equal((await Bot.getGroupMemberInfo("g", "u")).owner, "A")
  core.uins.reverse()
  assert.equal((await Bot.getGroupMemberInfo("g", "u")).owner, "B")
})

const ids = [42, "42", 0, "0", "0042", "9007199254740993", 9007199254740992, "alpha", "4e1", "42.0", " 42", ""]
for (const kind of ["Friend", "Group"]) {
  const field = kind === "Friend" ? "fl" : "gl"
  for (const id of ids) {
    test(`pick${kind} preserves exact ${typeof id}:${JSON.stringify(id)}`, () => {
      const first = account("A")
      first[field].set(id, {})
      if (typeof id === "string") first[field].set(Number(id), {})
      const { core } = coreFixture([first])
      assertPeer(core[`pick${kind}`](id, true), "A", id)
    })
  }
  for (const [input, key] of [[42, "42"], ["42", 42], [0, "0"], ["0", 0]]) {
    test(`pick${kind} safely matches ${typeof input}:${input} to ${typeof key}:${key}`, () => {
      const second = account("B")
      second[field].set(key, {})
      const { core } = coreFixture([account("A"), second])
      assertPeer(core[`pick${kind}`](input, true), "B", key)
    })
  }
  for (const id of ["0042", "9007199254740993", "4e1", "42.0", " 42", ""]) {
    test(`pick${kind} does not match lossy numeric alias of ${JSON.stringify(id)}`, () => {
      const second = account("B")
      second[field].set(Number(id), {})
      const { core } = coreFixture([account("A"), second])
      assert.equal(core[`pick${kind}`](id, true), false)
      assertPeer(core[`pick${kind}`](id), "A", id)
    })
  }
  test(`pick${kind} preserves preferred, last nonpreferred and raw-key priority`, () => {
    const bots = [account("A"), account("B"), account("C")]
    for (const bot of bots) bot[field].set(42, {})
    const { core } = coreFixture(bots)
    assertPeer(core[`pick${kind}`]("42", true), "A", 42)
    bots[0][field].clear()
    assertPeer(core[`pick${kind}`](42, true), "C", 42)
    bots[1][field].set("42", {})
    assertPeer(core[`pick${kind}`]("42", true), "B", "42")
    bots[2][field].set("42", {})
    assertPeer(core[`pick${kind}`]("42", true), "C", "42")
    assert.equal(core[`pick${kind}`]("unknown", true), false)
    assertPeer(core[`pick${kind}`]("unknown"), "A", "unknown")
  })
  test(`pick${kind} handles an empty preferred account and no accounts`, () => {
    const empty = account("A")
    delete empty.fl
    delete empty.gl
    const second = account("B")
    second[field].set("alpha", {})
    const { core } = coreFixture([empty, second])
    assertPeer(core[`pick${kind}`]("alpha", true), "B", "alpha")
    core.uins.length = 0
    assert.equal(core[`pick${kind}`]("alpha", true), false)
    assert.equal(core[`pick${kind}`]("alpha"), undefined)
  })
}

for (const [input, key] of [[42, "42"], ["42", 42], ["0042", "0042"], ["9007199254740993", "9007199254740993"], ["alpha", "alpha"], [0, "0"]]) {
  test(`friend member fallback ${typeof input}:${input} -> ${typeof key}:${key}`, () => {
    const info = Object.freeze({ user_id: key })
    const second = account("B", [], [], [["g", new Map([[key, info]])]])
    const { core } = coreFixture([account("A"), second])
    assertPeer(core.pickFriend(input, true), "B", key)
    assert.deepEqual(info, { user_id: key })
  })
}

test("member fallback keeps group insertion order and last-account duplicate priority", () => {
  const a = account("A", [], [], [["first", new Map([["u", {}]])]])
  const b = account("B", [], [], [["second", new Map([["u", {}]])]])
  const c = account("C", [], [], [["first", new Map([["u", {}]])]])
  const { core } = coreFixture([a, b, c])
  assertPeer(core.pickFriend("u", true), "C", "u")
  b.fl.set("u", {})
  assertPeer(core.pickFriend("u", true), "B", "u")
  a.fl.set("u", {})
  assertPeer(core.pickFriend("u", true), "A", "u")
})

test("same-group merged cache must not hide a member held by another account", () => {
  const a = account("A", [], [], [["g", new Map([["only-a", {}]])]])
  const b = account("B", [], [], [["g", new Map([["only-b", {}]])]])
  const { core } = coreFixture([a, b])
  assertPeer(core.pickFriend("only-a", true), "A", "only-a")
  assertPeer(core.pickFriend("only-b", true), "B", "only-b")
})

test("member fallback rejects lossy aliases and pickMember keeps user ID intact", () => {
  const bot = account("A", [], [42], [[42, new Map([[42, {}], [9007199254740992, {}]])]])
  const { core } = coreFixture([bot])
  assert.equal(core.pickFriend("0042", true), false)
  assert.equal(core.pickFriend("9007199254740993", true), false)
  assertPeer(core.pickMember("42", "0042"), "A", "0042")
})

test("existing group checks still stop event dispatch and account-specific sends", () => {
  const bot = account("A", [], ["blocked"])
  const { core, cfg } = coreFixture([bot])
  cfg.checkGroup = () => false
  let emitted = 0
  core.on("message", () => emitted++)
  assert.equal(core.em("message.group", { self_id: "A", group_id: "blocked" }), false)
  assert.equal(core.sendGroupMsg("A", "blocked", "payload"), false)
  assert.equal(core.sendGroupMsg("blocked", "payload"), false)
  assert.equal(emitted, 0)
  assert.equal(bot.sends.length, 0)
})
