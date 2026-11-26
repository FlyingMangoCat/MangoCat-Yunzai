import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// 发版不变量：任何一次发版或补丁提交都不允许破坏这两条
// （对应发布铁律：package.json 与 CHANGELOG 顶部版本标题必须同一版本号；
//  CHANGELOG 新版本段落在上，段内条目新→旧排列）

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8")

/** 按出现顺序提取全部版本段落标题（形如 "# 3.2.9"，允许前导空格与行尾空白） */
const sections = [...changelog.matchAll(/^\s*#\s*(\d+)\.(\d+)\.(\d+)\s*$/gm)].map((m) => ({
  text: `${m[1]}.${m[2]}.${m[3]}`,
  major: +m[1],
  minor: +m[2],
  patch: +m[3],
}))

test("package.json 版本号与更新日志顶部版本标题一致", () => {
  assert.ok(sections.length > 0, "更新日志中没有找到任何版本段落标题")
  const top = sections[0]
  assert.equal(
    `${pkg.version}`,
    top.text,
    "版本号错位：package.json 与更新日志顶部版本标题必须同步更新",
  )
})

test("更新日志版本段落按新到旧严格排列", () => {
  assert.ok(sections.length > 1, "至少应有两个版本段落才谈得上排序")
  for (let i = 1; i < sections.length; i++) {
    const prev = sections[i - 1]
    const cur = sections[i]
    const strictlyDescending =
      prev.major > cur.major ||
      (prev.major === cur.major && prev.minor > cur.minor) ||
      (prev.major === cur.major && prev.minor === cur.minor && prev.patch > cur.patch)
    assert.ok(
      strictlyDescending,
      `版本段落乱序：${prev.text} 出现在 ${cur.text} 之前但版本号不高于它`,
    )
  }
})
