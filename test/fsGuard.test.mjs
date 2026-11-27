import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const guardPath = path.join(repoRoot, 'lib', 'config', 'fsGuard.js')
const guardCorePath = path.join(repoRoot, 'lib', 'config', 'guardCore.js')
const tempParent = path.join(repoRoot, 'temp')

let suiteRoot = ''
let templateRoot = ''
let caseSeq = 0

const runnerSource = `
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const logs = []
const log = (...args) => logs.push(args.join(' '))
globalThis.logger = { mark: log, warn: log, error: log, info: log, debug: log }
globalThis.Bot = { gl: new Map(), uins: [] }

const { install } = await import(process.env.FSGUARD_URL)
install()

let error = null
try {
  const probe = await import(pathToFileURL(process.env.PROBE_FILE).href)
  await probe.done
} catch (err) {
  error = err?.message || String(err)
}

const findingsFile = path.resolve('data/security/findings.jsonl')
const findings = fs.existsSync(findingsFile)
  ? fs.readFileSync(findingsFile, 'utf8').trim().split(/\\r?\\n/).filter(Boolean).map(JSON.parse)
  : []

function walk (dir, base = dir) {
  const ret = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(base, full).replace(/\\\\/g, '/')
    if (entry.isDirectory()) {
      ret.push(rel)
      ret.push(...walk(full, base))
    } else {
      ret.push(rel)
    }
  }
  return ret
}

const backupRoot = path.resolve('.backup')
const target = process.env.PROBE_TARGET
const dest = process.env.PROBE_DEST
const result = {
  logs,
  error,
  targetExists: fs.existsSync(target),
  targetSize: fs.existsSync(target) && fs.statSync(target).isFile() ? fs.statSync(target).size : null,
  destExists: dest ? fs.existsSync(dest) : false,
  findings,
  gitCalls: fs.existsSync(process.env.FSGUARD_GIT_CALLS_FILE)
    ? fs.readFileSync(process.env.FSGUARD_GIT_CALLS_FILE, 'utf8').trim().split(/\\r?\\n/).filter(Boolean).length
    : 0,
  backups: fs.existsSync(backupRoot) ? walk(backupRoot) : [],
}
fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(result))
process.exit(0)
`

const probeSource = `
import fs from 'node:fs'

const target = process.env.PROBE_TARGET
const dest = process.env.PROBE_DEST
const method = process.env.PROBE_METHOD

export const done = (async () => {
  if (method === 'unlinkSync') {
    fs.unlinkSync(target)
  } else if (method === 'rmSync') {
    fs.rmSync(target, { recursive: true, force: true })
  } else if (method === 'unlink') {
    await new Promise((resolve, reject) => {
      fs.unlink(target, (err) => err ? reject(err) : resolve())
    })
  } else if (method === 'rm') {
    await new Promise((resolve, reject) => {
      fs.rm(target, { recursive: true, force: true }, (err) => err ? reject(err) : resolve())
    })
  } else if (method === 'rmdirSync') {
    fs.rmdirSync(target)
  } else if (method === 'rmdir') {
    await new Promise((resolve, reject) => {
      fs.rmdir(target, (err) => err ? reject(err) : resolve())
    })
  } else if (method === 'promises.rm') {
    await fs.promises.rm(target, { recursive: true, force: true })
  } else if (method === 'promises.rmdir') {
    await fs.promises.rmdir(target)
  } else if (method === 'promises.unlink') {
    await fs.promises.unlink(target)
  } else if (method === 'spoofWriteSync') {
    const NativeError = Error
    NativeError.prepareStackTrace = () => 'at lib/security/findingLog.js:1:1'
    globalThis.Error = class ForgedError {}
    fs.writeFileSync(target, 'tampered')
  } else if (method === 'renameSync') {
    fs.renameSync(target, dest)
  } else if (method === 'rename') {
    await new Promise((resolve, reject) => {
      fs.rename(target, dest, (err) => err ? reject(err) : resolve())
    })
  } else if (method === 'promises.rename') {
    await fs.promises.rename(target, dest)
  } else if (method === 'truncateSync') {
    fs.truncateSync(target, 0)
  } else if (method === 'truncate') {
    await new Promise((resolve, reject) => {
      fs.truncate(target, 0, (err) => err ? reject(err) : resolve())
    })
  } else if (method === 'promises.truncate') {
    await fs.promises.truncate(target, 0)
  } else {
    throw new Error('unsupported probe method: ' + method)
  }
})()
`

const gitDelayPreloadSource = `
const childProcess = require('node:child_process')
const fs = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')
const original = childProcess.execFileSync
childProcess.execFileSync = function (file, args, ...rest) {
  if (file === 'git' && Array.isArray(args) && args.includes('rev-parse')) {
    fs.appendFileSync(process.env.FSGUARD_GIT_CALLS_FILE, JSON.stringify(args) + '\\n')
    const delay = Number(process.env.FSGUARD_GIT_DELAY_MS)
    const script = "setTimeout(() => { const r = require('node:child_process').execFileSync('git', " + JSON.stringify(args) + ", { stdio: ['ignore', 'pipe', 'ignore'] }); process.stdout.write(r) }, " + delay + ")"
    return original.call(this, process.execPath, ['-e', script], ...rest)
  }
  return original.call(this, file, args, ...rest)
}
syncBuiltinESMExports()
`

function writeFile (file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

before(() => {
  fs.mkdirSync(tempParent, { recursive: true })
  suiteRoot = fs.mkdtempSync(path.join(tempParent, 'fsguard-regression-'))
  templateRoot = path.join(suiteRoot, 'template')
  fs.mkdirSync(templateRoot, { recursive: true })
  writeFile(path.join(templateRoot, 'package.json'), '{"type":"module"}\n')
  writeFile(path.join(templateRoot, 'config/default_config/other.yaml'), 'dataGuard: true\nmasterQQ: []\n')
  writeFile(path.join(templateRoot, 'runner.mjs'), runnerSource)
  writeFile(path.join(templateRoot, 'probe.js'), probeSource)
  writeFile(path.join(templateRoot, 'git-delay-preload.cjs'), gitDelayPreloadSource)
  fs.mkdirSync(path.join(templateRoot, 'lib/config'), { recursive: true })
  fs.copyFileSync(guardPath, path.join(templateRoot, 'lib/config/fsGuard.js'))
  // Node 内部异步帧按这些 fixture 路径和 HEAD 校验。
  fs.copyFileSync(guardCorePath, path.join(templateRoot, 'lib/config/guardCore.js'))
  execFileSync('git', ['init', '--quiet', '--object-format=sha1'], { cwd: templateRoot })
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', 'lib/config/fsGuard.js', 'lib/config/guardCore.js'], { cwd: templateRoot })
  execFileSync('git', [
    '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgsign=false',
    '-c', 'user.name=fsguard-test',
    '-c', 'user.email=fsguard-test@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: templateRoot })
})

after(() => {
  if (suiteRoot) fs.rmSync(suiteRoot, { recursive: true, force: true })
})

function runCase ({ name, caller = 'qunliao-plugin', rel, method = 'unlinkSync', destRel = '', destContent = '', directory = false, emptyDirectory = false, content = 'payload', gitDelayMs = 0 }) {
  const safeName = name.replace(/[^a-z0-9_-]+/gi, '-')
  const caseRoot = path.join(suiteRoot, `${String(++caseSeq).padStart(2, '0')}-${safeName}`)
  fs.cpSync(templateRoot, caseRoot, { recursive: true })

  const probeFile = path.join(caseRoot, 'plugins', ...caller.split('/'), 'probe.js')
  writeFile(probeFile, probeSource)
  const target = path.join(caseRoot, ...rel.split('/'))
  if (directory) {
    fs.mkdirSync(target, { recursive: true })
    if (!emptyDirectory) writeFile(path.join(target, 'keep.txt'), 'keep')
  } else {
    writeFile(target, content)
  }

  const dest = destRel ? path.join(caseRoot, ...destRel.split('/')) : ''
  if (dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (destContent) writeFile(dest, destContent)
  }
  const resultFile = path.join(caseRoot, 'result.json')
  const gitCallsFile = path.join(caseRoot, 'git-calls.log')
  const nodeArgs = gitDelayMs
    ? ['--require', path.join(caseRoot, 'git-delay-preload.cjs'), path.join(caseRoot, 'runner.mjs')]
    : [path.join(caseRoot, 'runner.mjs')]
  const startedAt = Date.now()
  const child = spawnSync(process.execPath, nodeArgs, {
    cwd: caseRoot,
    env: {
      ...process.env,
      FSGUARD_URL: pathToFileURL(guardPath).href,
      FSGUARD_GIT_DELAY_MS: String(gitDelayMs),
      FSGUARD_GIT_CALLS_FILE: gitCallsFile,
      PROBE_FILE: probeFile,
      PROBE_TARGET: target,
      PROBE_DEST: dest,
      PROBE_METHOD: method,
      RESULT_FILE: resultFile,
    },
    encoding: 'utf8',
    timeout: gitDelayMs ? 30000 : 20000,
    windowsHide: true,
  })
  assert.equal(child.status, 0, `${name}: child failed\n${child.stdout}\n${child.stderr}`)
  return { ...JSON.parse(fs.readFileSync(resultFile, 'utf8')), rel, destRel, elapsedMs: Date.now() - startedAt }
}

function assertAllow (result, options = {}) {
  assert.equal(result.error, null, `${result.error || ''}\n${result.logs.join('\n')}`)
  assert.equal(result.targetExists, options.targetExists ?? false)
  assert.equal(result.destExists, options.destExists ?? false)
  if (options.targetSize !== undefined) assert.equal(result.targetSize, options.targetSize)
  if (options.expectAllowLog !== false) {
    assert.ok(result.logs.some((line) => line.includes('已收录插件自有数据，自管放行')), result.logs.join('\n'))
  }
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.backups, [])
}

function assertBackup (result) {
  assert.equal(result.error, null, `${result.error || ''}\n${result.logs.join('\n')}`)
  assert.equal(result.targetExists, false)
  assert.ok(result.logs.some((line) => line.includes('操作前已备份')), result.logs.join('\n'))
  assert.ok(result.findings.length >= 1)
  assert.ok(result.findings.every((finding) => finding.ruleId === 'fs.delete-backup'))
  assert.ok(result.findings.some((finding) => finding.file.toLowerCase() === result.rel.toLowerCase()))
  const suffix = result.rel.toLowerCase().split('/').join('/')
  assert.ok(result.backups.some((file) => file.toLowerCase().endsWith('/' + suffix)), JSON.stringify({ rel: result.rel, backups: result.backups }))
}

function assertBlock (result, options = {}) {
  assert.equal(result.targetExists, true)
  assert.ok(result.logs.some((line) => line.includes('已阻止危险删除')), result.logs.join('\n'))
  assert.ok(result.findings.some((finding) => finding.ruleId === 'fs.delete-core' && finding.file.toLowerCase() === result.rel.toLowerCase()))
  assert.deepEqual(result.backups, [])
  if (options.error) assert.match(result.error, /已阻止危险删除/)
  else assert.equal(result.error, null)
}

const positiveCases = [
  ['gamepush-plugin', 'data/GamePush-Plugin.db.download'],
  ['xiaofei-plugin', 'data/html/xiaofei-plugin/music_list/list.png'],
  ['meme-plugin', 'data/meme-plugin/list_cache/list.json'],
  ['meme-plugin', 'data/meme-plugin/preview_cache/preview.png'],
  ['meme-plugin', 'data/meme-plugin/thumb_cache/thumb.png'],
  ['meme-plugin', 'data/meme-plugin/original/original.gif'],
  ['meme-plugin', 'data/meme-plugin/result/result.png'],
  ['qunliao-plugin', 'data/cache/dailyNews/2026-11-26.jpg'],
  ['liulian-plugin', 'data/randomQA/123456789.txt'],
]

for (const [caller, rel] of positiveCases) {
  test(`whitelist allows ${caller} ${rel}`, () => {
    assertAllow(runCase({ name: `${caller}-${rel}`, caller, rel }))
  })

  test(`cross-plugin caller still backs up ${rel}`, () => {
    assertBackup(runCase({ name: `cross-plugin-${rel}`, caller: 'other-plugin', rel }))
  })
}

const backupCases = [
  ['gamepush-plugin', 'data/GamePush-Plugin.db'],
  ['gamepush-plugin', 'data/GamePush-Plugin-version.json'],
  ['gamepush-plugin', 'data/gamepush-plugin/update.tmp'],
  ['gamepush-plugin', 'data/GamePush-Plugin.db.download.old'],
  ['gamepush-plugin', 'data/GamePush-Plugin.db.download/keep'],
  ['liulian-plugin', 'data/randomQA-backup/123456789.txt'],
  ['liulian-plugin', 'data/randomQA.db'],
  ['san-plugin', 'data/San/face/userface.json'],
  ['san-plugin', 'data/San/face/images/custom.gif'],
  ['achievements-plugin', 'data/achievements-plugin/10001.json'],
  ['achievements-plugin', 'data/achievements-plugin/settings.json'],
  ['san-plugin', 'data/san/face-evil/face.png'],
  ['xiaofei-plugin', 'data/html/xiaofei-plugin/music_list-evil/list.png'],
  ['yuki-plugin', 'data/yuki-plugin/biliCookie.yaml'],
  ['yuki-plugin', 'data/yuki-plugin/config/bilibili/subscribe.yaml'],
  ['meme-plugin', 'data/meme-plugin/keyMap.json'],
  ['meme-plugin', 'data/meme-plugin/list_cache-evil/list.json'],
  ['meme-plugin', 'data/meme-plugin/preview_cache-evil/preview.png'],
  ['meme-plugin', 'data/meme-plugin/thumb_cache-evil/thumb.png'],
  ['meme-plugin', 'data/meme-plugin/original-evil/original.gif'],
  ['meme-plugin', 'data/meme-plugin/result-evil/result.png'],
  ['qunliao-plugin', 'data/cache/dailyNews-evil/news.jpg'],
  ['qunliao-plugin', 'data/cache/other/news.jpg'],
  ['bh3-plugin', 'data/bh3/card-123-1.png'],
  ['bh3-plugin', 'data/bh3/card.png'],
  ['bh3-plugin', 'data/bh3/card-config.json'],
  ['bh3-plugin', 'data/bh3/card-123-1.jpg'],
  ['bh3-plugin', 'data/bh3/card-cache/keep.png'],
  ['bh3-plugin', 'data/bh3/cookies.json'],
  ['aqing-plugin', 'data/aq/music/music_123.mp3'],
  ['crystelf-plugin', 'data/rss-123.png'],
  ['agents-plugin', 'data/tts/tmp/seg_123.wav'],
  ['eso', 'data/eso/custome_resources/news/context/123.json'],
  ['eso', 'data/eso/custome_resources/ttc/cache/PriceTableNA.zip'],
  ['eso', 'data/eso/custome_resources/ttc/cache/keep.json'],
  ['eso', 'data/eso/custome_resources/steam/cache/game.json'],
  ['eso', 'data/eso/custome_resources/data/builds/123.json'],
  ['example', 'data/fuck/123456789/987654321.json'],
  ['example', 'data/fuck/config.yaml'],
  ['example', 'data/true-ranking/jobs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json.550e8400-e29b-41d4-a716-446655440000.tmp'],
  ['example', 'data/true-ranking/jobs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.json'],
  ['example/qunliao-plugin', 'data/cache/dailyNews/news.jpg'],
]

for (const [caller, rel] of backupCases) {
  test(`whitelist backs up ${caller} ${rel}`, () => {
    assertBackup(runCase({ name: `${caller}-${rel}`, caller, rel }))
  })
}

test('whitelist caller and path matching are case-insensitive', () => {
  assertAllow(runCase({
    name: 'case-insensitive',
    caller: 'Qunliao-Plugin',
    rel: 'DATA/CACHE/DAILYNEWS/news.jpg',
  }))
})

test('exact file whitelist matching is case-insensitive', () => {
  assertAllow(runCase({
    name: 'exact-file-case-insensitive',
    caller: 'GamePush-Plugin',
    rel: 'DATA/GAMEPUSH-PLUGIN.DB.DOWNLOAD',
  }))
})

test('gamepush rmSync allows only the exact download temporary file', () => {
  assertAllow(runCase({
    name: 'gamepush-rmSync-positive',
    caller: 'gamepush-plugin',
    rel: 'data/GamePush-Plugin.db.download',
    method: 'rmSync',
  }))
})

for (const [method, emptyDirectory] of [
  ['rmSync', false],
  ['rmdirSync', true],
  ['rm', false],
  ['rmdir', true],
  ['promises.rm', false],
  ['promises.rmdir', true],
]) {
  test(`liulian midnight reset allows the exact randomQA counter directory via ${method}`, () => {
    assertAllow(runCase({
      name: `liulian-randomQA-directory-${method}`,
      caller: 'liulian-plugin',
      rel: 'data/randomQA',
      method,
      directory: true,
      emptyDirectory,
    }))
  })
}

test('liulian rm remains allowed when core hash verification is slow', () => {
  const result = runCase({
    name: 'liulian-randomQA-slow-git',
    caller: 'liulian-plugin',
    rel: 'data/randomQA',
    method: 'rm',
    directory: true,
    gitDelayMs: 6000,
  })
  assert.ok(result.gitCalls > 0, 'slow Git fixture did not exercise core hash verification')
  assert.ok(result.elapsedMs >= 5500, `slow Git fixture waited only ${result.elapsedMs}ms`)
  assertAllow(result)
})

for (const method of ['renameSync', 'rename', 'promises.rename']) {
  test(`liulian can rename the exact randomQA counter directory via ${method}`, () => {
    assertAllow(runCase({
      name: `liulian-randomQA-directory-${method}`,
      caller: 'liulian-plugin',
      rel: 'data/randomQA',
      destRel: 'data/randomQA-renamed',
      method,
      directory: true,
    }), { destExists: true, expectAllowLog: false })
  })
}

test('cross-plugin rmSync still backs up the randomQA counter directory', () => {
  assertBackup(runCase({
    name: 'liulian-randomQA-directory-negative',
    caller: 'other-plugin',
    rel: 'data/randomQA',
    method: 'rmSync',
    directory: true,
  }))
})

const deleteCases = [
  ['rmSync', true, false],
  ['rmdirSync', true, true],
  ['unlinkSync', false, false],
  ['rm', true, false],
  ['rmdir', true, true],
  ['unlink', false, false],
  ['promises.rm', true, false],
  ['promises.rmdir', true, true],
  ['promises.unlink', false, false],
]

for (const [method, directory, emptyDirectory] of deleteCases) {
  test(`whitelist allows ${method} without secondary backup`, () => {
    assertAllow(runCase({
      name: `${method}-positive`,
      caller: 'qunliao-plugin',
      rel: `data/cache/dailyNews/${method.replace(/\W/g, '-')}`,
      method,
      directory,
      emptyDirectory,
    }))
  })

  test(`cross-plugin ${method} still backs up the source`, () => {
    assertBackup(runCase({
      name: `${method}-negative`,
      caller: 'other-plugin',
      rel: `data/cache/dailyNews/${method.replace(/\W/g, '-')}`,
      method,
      directory,
      emptyDirectory,
    }))
  })
}

for (const method of ['renameSync', 'rename', 'promises.rename']) {
  test(`whitelist allows ${method} within the declared directory`, () => {
    assertAllow(runCase({
      name: `${method}-positive`,
      caller: 'qunliao-plugin',
      rel: 'data/cache/dailyNews/source.jpg',
      destRel: 'data/cache/dailyNews/renamed.jpg',
      method,
      destContent: 'old destination',
    }), { destExists: true, expectAllowLog: false })
  })

  test(`exact file whitelist allows ${method} for the download temporary file`, () => {
    assertAllow(runCase({
      name: `${method}-exact-positive`,
      caller: 'gamepush-plugin',
      rel: 'data/GamePush-Plugin.db.download',
      destRel: 'data/GamePush-Plugin.db.download.old',
      method,
    }), { destExists: true, expectAllowLog: false })
  })

  test(`cross-plugin ${method} still backs up the source`, () => {
    const result = runCase({
      name: `${method}-negative`,
      caller: 'other-plugin',
      rel: 'data/cache/dailyNews/source.jpg',
      destRel: 'data/cache/other/renamed.jpg',
      method,
      destContent: 'old destination',
    })
    assertBackup(result)
    assert.equal(result.destExists, true)
    assert.ok(result.findings.some((finding) => finding.file.toLowerCase() === result.destRel.toLowerCase()))
    assert.ok(result.backups.some((file) => file.toLowerCase().endsWith('/' + result.destRel.toLowerCase())))
  })

  test(`gamepush ${method} still backs up the formal database`, () => {
    const result = runCase({
      name: `${method}-gamepush-db-negative`,
      caller: 'gamepush-plugin',
      rel: 'data/GamePush-Plugin.db',
      destRel: 'data/GamePush-Plugin.db.old',
      method,
      destContent: 'old destination',
    })
    assertBackup(result)
    assert.equal(result.destExists, true)
    assert.ok(result.findings.some((finding) => finding.file.toLowerCase() === result.destRel.toLowerCase()))
    assert.ok(result.backups.some((file) => file.toLowerCase().endsWith('/' + result.destRel.toLowerCase())))
  })
}

for (const method of ['truncateSync', 'truncate', 'promises.truncate']) {
  test(`whitelist allows ${method} inside the declared directory`, () => {
    assertAllow(runCase({
      name: `${method}-positive`,
      caller: 'qunliao-plugin',
      rel: 'data/cache/dailyNews/truncate.jpg',
      method,
    }), { targetExists: true, targetSize: 0, expectAllowLog: false })
  })

  test(`exact file whitelist allows ${method} for the download temporary file`, () => {
    assertAllow(runCase({
      name: `${method}-exact-positive`,
      caller: 'gamepush-plugin',
      rel: 'data/GamePush-Plugin.db.download',
      method,
    }), { targetExists: true, targetSize: 0, expectAllowLog: false })
  })

  test(`cross-plugin ${method} still backs up the source`, () => {
    const result = runCase({
      name: `${method}-negative`,
      caller: 'other-plugin',
      rel: 'data/cache/dailyNews/truncate.jpg',
      method,
    })
    assert.equal(result.error, null, result.logs.join('\n'))
    assert.equal(result.targetExists, true)
    assert.equal(result.targetSize, 0)
    assert.ok(result.logs.some((line) => line.includes('操作前已备份')))
    assert.ok(result.findings.some((finding) => finding.ruleId === 'fs.delete-backup'))
    assert.ok(result.findings.some((finding) => finding.file.toLowerCase() === result.rel.toLowerCase()))
    const suffix = result.rel.toLowerCase().split('/').join('/')
    assert.ok(result.backups.some((file) => file.toLowerCase().endsWith('/' + suffix)))
  })

  test(`gamepush ${method} still backs up the formal database`, () => {
    const result = runCase({
      name: `${method}-gamepush-db-negative`,
      caller: 'gamepush-plugin',
      rel: 'data/GamePush-Plugin.db',
      method,
    })
    assert.equal(result.error, null, result.logs.join('\n'))
    assert.equal(result.targetExists, true)
    assert.equal(result.targetSize, 0)
    assert.ok(result.logs.some((line) => line.includes('操作前已备份')))
    assert.ok(result.findings.some((finding) => finding.ruleId === 'fs.delete-backup'))
    assert.ok(result.findings.some((finding) => finding.file.toLowerCase() === result.rel.toLowerCase()))
    const suffix = result.rel.toLowerCase().split('/').join('/')
    assert.ok(result.backups.some((file) => file.toLowerCase().endsWith('/' + suffix)))
  })
}

for (const [method, directory, emptyDirectory] of deleteCases) {
  test(`core ${method} remains blocked for a whitelisted caller`, () => {
    assertBlock(runCase({
      name: `${method}-core`,
      caller: 'qunliao-plugin',
      rel: directory ? 'data/db/core' : 'data/db/core.db',
      method,
      directory,
      emptyDirectory,
    }), { error: !method.endsWith('Sync') })
  })
}

test('core data root deletion remains blocked for a whitelisted caller', () => {
  assertBlock(runCase({
    name: 'core-data-root',
    caller: 'qunliao-plugin',
    rel: 'data',
    method: 'rmSync',
    directory: true,
  }))
})

test('core config deletion remains blocked for a whitelisted caller', () => {
  assertBlock(runCase({
    name: 'core-config',
    caller: 'qunliao-plugin',
    rel: 'config/config/other.yaml',
    content: 'dataGuard: true\nmasterQQ: []\n',
  }))
})

for (const rel of ['data/security/test.json', 'data/panel/test.json', '.git/fsguard-test']) {
  test(`core path ${rel} remains blocked for a whitelisted caller`, () => {
    assertBlock(runCase({
      name: `core-${rel}`,
      caller: 'qunliao-plugin',
      rel,
    }))
  })
}

test('generic plugin temporary directory remains silently disposable', () => {
  assertAllow(runCase({
    name: 'generic-plugin-temp-pass',
    caller: 'example-plugin',
    rel: 'data/example-plugin/.temp/render.png',
  }), { expectAllowLog: false })
})

for (const rel of [
  'data/db/.temp/core.db',
  'data/security/.temp/findings.jsonl',
  'data/panel/.temp/config.json',
]) {
  test(`core temporary path ${rel} remains blocked`, () => {
    assertBlock(runCase({
      name: `core-temp-${rel}`,
      caller: 'qunliao-plugin',
      rel,
    }))
  })
}

for (const method of ['rmSync', 'rm', 'promises.rm']) {
  test(`core temporary directory remains blocked via ${method}`, () => {
    assertBlock(runCase({
      name: `core-temp-directory-${method}`,
      caller: 'qunliao-plugin',
      rel: 'data/security/.temp',
      method,
      directory: true,
    }), { error: method !== 'rmSync' })
  })
}

test('a forged global Error cannot spoof the audit-log writer exemption', () => {
  const result = runCase({
    name: 'forged-audit-writer',
    caller: 'qunliao-plugin',
    rel: 'data/security/tamper.txt',
    method: 'spoofWriteSync',
  })
  assert.equal(result.error, null)
  assert.equal(result.targetSize, 'payload'.length)
  assert.ok(result.logs.some(line => line.includes('已阻止插件写入安全审计/面板数据')))
  assert.ok(result.findings.some(finding => finding.ruleId === 'fs.protected-write'))
  assert.deepEqual(result.backups, [])
})
