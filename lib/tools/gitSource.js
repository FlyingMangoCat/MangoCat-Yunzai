import { exec } from "node:child_process"

/**
 * git 远端探活与换源
 *
 * update 命令（plugins/other/update.js）与面板更新（lib/panel/plugins.js）共用。
 * 背景：远端 404/转私有/风控时，gitee 不直接报 404，而是要求输入用户名（供以
 * 私有方式访问）；更新器统一以 GIT_TERMINAL_PROMPT=0 运行，表现为
 * "could not read Username ... terminal prompts disabled"，用户看不出真实原因。
 * 因此在拉取前先 ls-remote 探活，失效则按候选源（台账收录地址）依次换源重试；
 * 全部不可用则恢复原远端并抛出可读错误，由调用方回复用户。
 * execFn 仅用于测试注入，生产走 runGit。
 */
function runGit(cmd, timeout = 30000) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr })
    })
  })
}

/** 从台账条目取候选源：downloads 在前（收录时按主→镜像排序），homepage 兜底 */
export function candidatesFromLedger(ledgerItems, dir) {
  const key = String(dir || "").toLowerCase()
  if (!key) return []
  const entry = (ledgerItems || []).find(
    (i) => String(i.dir || "").toLowerCase() === key || String(i.name || "").toLowerCase() === key,
  )
  if (!entry) return []
  return [...(entry.downloads || []), entry.homepage].filter(Boolean)
}

/**
 * 探活当前 origin；失效则按候选源依次 set-url + ls-remote 探测，命中即保留新源；
 * 全部失效恢复原远端并抛错。无 origin（非 git 仓库/未设远端）时原样放行，交回
 * 调用方按原有流程报错。
 * @returns {Promise<{url: string, switched: boolean}>}
 */
export async function ensureRemoteUsable({ dir = ".", candidates = [], execFn = runGit, log = () => {} } = {}) {
  const git = (cmd) => execFn(`git -C "${dir}" ${cmd}`)
  const curRet = await git("remote get-url origin")
  const cur = String(curRet.stdout || "").trim()
  if (curRet.error || !cur) return { url: "", switched: false }

  const first = await git("ls-remote origin HEAD")
  if (!first.error) return { url: cur, switched: false }

  const tried = []
  for (const raw of candidates) {
    const url = String(raw || "").trim().replace(/\/+$/, "")
    if (!/^https?:\/\//i.test(url) || url === cur || tried.includes(url)) continue
    tried.push(url)
    await git(`remote set-url origin "${url}"`)
    const probe = await git("ls-remote origin HEAD")
    if (!probe.error) {
      log(`远端不可用，已换源：${url}`)
      return { url, switched: true }
    }
    log(`候选源不可用：${url}`)
  }
  await git(`remote set-url origin "${cur}"`)
  throw new Error(
    `远端已失效：${cur}（探活失败）；${tried.length ? `候选源 ${tried.join("、")} 均不可用，` : "无候选源，"}已恢复原远端。请检查仓库是否改名/转私有，或手动更新远端地址`,
  )
}
