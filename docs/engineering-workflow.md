# 工程与工具流程

> 覆盖：静态审计脚本怎么用、插件收录检查跑什么、PR 有什么要求、棘轮基线怎么维护。
> 当前状态：审计脚本已可用；审计 CI 已接入（`.github/workflows/plugin-audit.yml`，PR 触发，棘轮门禁）。

---

## 0. 先分清三种「检查」

| 目的 | 命令 | 说明 |
|---|---|---|
| **安全 / 合规审计** | `node tools/plugin-audit.mjs <目录>` | 纯静态、不联网、不改源码；只读文件并写报告 |
| **功能自检** | `npm test` | 伪造一条群消息（默认「十连」）跑插件，测功能不是安全；配置见 `config/test/default.yaml` |
| **代码风格** | `npm run lint-check` | Prettier 检查（`lint` 会自动改写） |

三者互不替代。PR 里说的「审计过了」指第一种，不是 `npm test`。

> 注：面板里的「审计」是**操作日志**（谁装了 / 改了 / 删了什么），不是本工具；静态安全审计只跑 `tools/plugin-audit.mjs`。

---

## 1. 审计脚本快速开始

```bash
# 单个插件
node tools/plugin-audit.mjs plugins/example

# 多个插件
node tools/plugin-audit.mjs plugins/example plugins/liulian-plugin

# 只出终端，不写报告
node tools/plugin-audit.mjs plugins/example --no-md

# 额外输出 JSON（给面板 / CI 消费）
node tools/plugin-audit.mjs plugins/example --json audit.json
```

默认报告写到 `audit-reports/audit-<插件名>-<日期>.md`，不会污染当前目录。多个目标同名时自动加 `-2` 后缀，不会互相覆盖。

---

## 2. 选项

| 选项 | 作用 |
|---|---|
| `--since <rev>` | **增量**：只扫 `git diff <rev>` 之后新增/修改的行（新文件全扫） |
| `--ratchet [路径]` | **棘轮**：与基线比对，出现新增命中即 exit 1；修复则自动下调基线。默认 `tools/plugin-audit-baseline.json` |
| `--accept` | 配合 `--ratchet`：把当前结果接受为新基线（有风险，会打印提示） |
| `--fail-on <level>` | 不带基线也能拦 CI：`critical` / `high` / `medium` / `low`，命中即 exit 1 |
| `--rules <json>` | 外部规则覆盖：按 id 合并；`disable` 关闭单条；`replace: true` 整份替换 |
| `--dump-rules <json>` | 导出内置规则为 JSON，改完可 `--rules` 回灌 |
| `--md <路径>` | 指定报告路径；多目标时当作**前缀**（`<前缀>-<插件名>.md`） |
| `--no-md` | 只出终端结论 |
| `--json <路径>` | 额外输出 JSON（含 `results` 与 `ratchet`） |
| `--top <N>` | 终端最多显示 N 条（默认 15） |
| `--all-md` | 报告列出全部命中，不按级别截断 |

---

## 3. 退出码

| 码 | 含义 |
|---|---|
| `0` | 未触发门禁 |
| `1` | `--fail-on` 命中阈值，或 `--ratchet` 出现新增 |
| `2` | 用法错误（如 `--fail-on` 给了非法值） |

CI 只认退出码，所以要么用 `--fail-on`，要么用 `--ratchet`。

---

## 4. 分级怎么读

| 级别 | 典型含义 | 收录处置 |
|---|---|---|
| `CRITICAL` | 用户输入直达危险 sink 且同文件无门禁；或云崽特有后门模式（`user_id` 哈希比对、写死 QQ） | 必须逐条人读定性；属实即不收录 |
| `HIGH` | 强候选（有输入或有门禁缺失之一；凭据与外发同现） | 必须逐条定性，清零或证明误报 |
| `MEDIUM` | 能力或可疑（导入 `child_process`、混淆、动态执行但未见输入） | 需在报告/PR 说明理由 |
| `LOW` | 资产、仿冒包名、裸 IP、哈希字面量 | 登记即可 |
| `PASS` | 无命中 | — |

注意：`CRITICAL` / `HIGH` 是**候选**，不是判决。工具负责把可疑点筛出来，定性必须人读源码。

---

## 5. 它到底扫了什么（S0–S4）

- **S0 取证**：git HEAD、提交日期、文件清单、体积、跳过项
- **S1 清点**：按文件类型路由（code / config / doc / pkg / skip）；二进制资产；`package.json` 供应链（install 钩子、git/URL 依赖、仿冒包名）
- **S2 红线扫描**：按规则家族扫源码
- **S3 可达性分诊**：sink 所在行是否**直接**出现输入（含一跳变量）+ 同文件有无门禁；另查「无效防御」（`DEF-NOOP`）
- **S4 定性**：人读源码——工具不做

工具自己声明：S3 是「邻近 + 一跳变量」，**不是完整数据流**；跨函数、经文件/Redis 中转的传播看不到。

---

## 6. 规则家族

| 家族 | 抓什么 | 例子 |
|---|---|---|
| RCE | 代码 / 命令执行 | `eval`、`new Function`、`vm`、`exec/spawn`、`child_process` |
| 混淆 | 编码 / 混淆 | `atob` / base64、`fromCharCode`、`_0x` / `jsjiami` / RC4 / `v8.deserialize` |
| 凭据 | 硬编码密钥 | `sk-`、`api_key/secret/token/password` 赋值、`Authorization` |
| 云崽特有 | 后门模式 | `user_id` 哈希比对、32/40 位哈希字面量、写死 `masterQQ` / 白名单 |
| 外联 | 数据外发 | 裸 IP、凭据与外发同现 |
| 其它 | 常见风险 | 原型链污染、删除文件 |
| 防御 | 假防御 | `DEF-NOOP`：名字像校验、实际空转或原样返回 |
| 供应链 | 依赖风险 | install 钩子、git/URL 依赖、仿冒包名 |
| 资产 | 二进制 | `.node` / `.exe` / `.dll` / `.so` / `.wasm` |

> 只有 `code` 类型文件跑全部家族；`config` / `doc` / `pkg` 只跑「凭据 / 外联」，避免 Markdown 里出现 `eval(` 就报警。

---

## 7. 插件收录检查（判定标准）

### 7.1 硬门槛（命中即不收录）

对应契约 §4，七条红线：

1. 后门 / 隐藏授权哈希 / 写死他人 QQ
2. 无权限门禁的 RCE、任意命令执行、动态执行用户输入
3. 硬编码真实密钥 / Cookie / 密码
4. 未声明的用户数据外传
5. 远端下载后解码执行
6. 闭源二进制核心 / 无法解释的混淆执行体
7. 恶意 install 钩子 / 供应链投毒

### 7.2 审计判定

| 项 | 要求 |
|---|---|
| `CRITICAL` | 必须为 0；若有，逐条定性，属实即不收录 |
| `HIGH` | 必须为 0；若保留，需写明「为什么是误报」及依据 |
| `MEDIUM` | 逐条说明；可接受，但需在报告/PR 记录理由 |
| `LOW` | 登记，不阻塞 |
| 二进制 | 必须披露；闭源核心不收录 |
| 版本哈希 | 记录 git HEAD（非 git 目录标「待核」） |
| 供应链 | install 钩子、git 依赖、仿冒包名逐条说明 |

### 7.3 结论落台账

把 `HEAD + 日期 + 结论 + 理由` 写进收录台账（`参考内容/include-新结构草案.md` 或面板收录列表），确保下次可复核。

> 合规层（L1/L2/L3）来源优先级：已安装插件的 `plugin.yaml`（`isolation`→L3，`permissions`→L2）> 台账「层」列 > `panel.ledger.layers`（按目录名/插件名）> 默认（官方/已收录 L1，未审核/失效 L0）。

---

## 8. 增量与棘轮

```bash
# 只扫某个提交之后改动（适合 review 单个 PR）
node tools/plugin-audit.mjs plugins/xxx --since origin/master

# 首次：建立基线
node tools/plugin-audit.mjs plugins/xxx --ratchet

# 之后：有新增即 exit 1；修复会自动下调基线
node tools/plugin-audit.mjs plugins/xxx --ratchet

# 显式接受新增（必须在 PR 里写理由）
node tools/plugin-audit.mjs plugins/xxx --ratchet --accept
```

基线文件默认 `tools/plugin-audit-baseline.json`，按插件名存：`head`、`date`、`counts`、命中指纹。**不要随手 `--accept`**——它等于承认新增问题。

---

## 9. 规则外置与误报处理

```bash
# 导出内置规则
node tools/plugin-audit.mjs --dump-rules rules.json

# 用外部规则跑（按 id 合并，可 disable 单条）
node tools/plugin-audit.mjs plugins/xxx --rules rules.json
```

处理误报的顺序：

1. 先确认是不是 fp 基线漏了（看 `hint`）
2. 单插件已知误报：用 `--rules` **局部** disable 对应 id，PR 写明 `id + 理由`
3. 不要为了过审删代码、改内置规则、或直接 `--accept`

---

## 10. PR 要求

### 10.1 必跑

```bash
# 一键审改动（推荐；CI 跑的是同一个脚本）
bash scripts/ci-audit.sh

# 想全量
AUDIT_ALL=1 bash scripts/ci-audit.sh

# 新插件第一次：先建基线再继续
INIT_NEW=1 bash scripts/ci-audit.sh

# 代码风格
npm run lint-check

# 改运行时才需要：功能自检（需先配 config/test/default.yaml）
npm test
```

> 自觉原则：PR 作者应先在本地跑过 `bash scripts/ci-audit.sh`，把结论写进 PR；CI 只是兜底，不是替你检查的第一道。
>
> 注意：`plugins/.gitignore` 默认 `*` 全忽略、只白名单内置插件。提交新插件必须 `git add -f plugins/<name>/...`，否则 CI 的 diff 看不到它，门禁等于没挂。

### 10.2 描述必须包含

- 改了什么、为什么
- 审计结论：`CRITICAL / HIGH / MEDIUM / LOW` 各多少，CRITICAL/HIGH 如何定性
- 新增 `MEDIUM` / `LOW` 的逐条说明
- 改 `tools/plugin-audit.mjs`：附正例、反例各一（证明规则没被改坏）
- 改权限 / 鉴权 / 契约：影响面与回滚方式

### 10.3 禁止

- 提交真实密钥、`node_modules`、大二进制
- 未说明就 `--accept` 新增
- 绕过 L1 兼容（见契约 §2）
- 用「删掉命中代码」代替定性

### 10.4 契约类改动

走 Issue + 公示 7 天（契约 §7），PR 里贴 Issue 链接；默认无异议通过，有争议才投票。

---

## 11. CI 门禁（已接入）

`scripts/ci-audit.sh` 是平台无关入口，GitHub 和 Gitee 都只调它：

- **GitHub**：`.github/workflows/plugin-audit.yml`（PR 触发）
- **Gitee**：Gitee Go 流水线里跑 `bash scripts/ci-audit.sh`（或走 Check Runs API 接门禁）

行为：

1. 取改动的插件目录（本地还会算未提交、未跟踪的文件）
2. 新插件（基线里没有）→ 失败，提示先 `--ratchet` 建基线并提交；本地可 `INIT_NEW=1` 直接建
3. 已有插件 → `--ratchet --fail-on critical`：只在**新增命中**或出现 `CRITICAL` 时失败
4. 没改插件 → 用 `plugins/example` 做冒烟

环境变量：

| 变量 | 作用 |
|---|---|
| `BASE_REF` | 比对基线，默认 `origin/master` |
| `AUDIT_ALL=1` | 全量审所有插件 |
| `INIT_NEW=1` | 新插件先建基线再继续 |

基线文件 `tools/plugin-audit-baseline.json` 必须随仓库提交。维护约定：

- 修复问题后本地跑一次 `--ratchet`，基线会自动下调，连同修复一起提交
- 新插件首次入库：本地 `--ratchet` 建基线 → 人工确认报告 → 提交基线与插件
- 不要为了过 CI 用 `--accept` 把新增问题吃进基线

> Gitee 不执行 `.github/workflows`，需在「服务 → Gitee Go」里配流水线，或在保护分支用 Check Runs API 接门禁。

---

## 12. 常见问题

**Q：报了一条 CRITICAL，但我确定是安全的，怎么办？**
先看 `hint` 和 `why`；确认是 fp 漏了，就用 `--rules` 局部 disable 该 id，并在报告里写清依据。不要直接 `--accept`。

**Q：门禁明明在别处，工具说「无门禁」。**
这是已知盲区：门禁判定以「同文件」为单位。若门禁在统一 rule 注册处或基类，会误判。报告里会提示「门禁可能在上层调用方」，人读确认即可。

**Q：非 git 目录的插件怎么审？**
会显示「哈希待核」。收录前先确认来源（仓库地址 + 版本），否则无法复核。

**Q：大文件 / 压缩包没扫？**
大于 1.5MB 跳过；压缩文件的混淆规则会降级。报告「未扫描文件」里会列出来，需人工看。

**Q：第三方压缩库（如 `*.min.js`）里的 `new Function` 被报 HIGH？**
这类多是库的合法用法，工具分不清「库代码」和「业务代码」。按误报处理：在 PR 说明，或用 `--rules` 局部 disable 对应 id；不要把整个 `resources/` 加进白名单。

**Q：新插件提交了，CI 却没检查到？**
`plugins/.gitignore` 默认全忽略，必须 `git add -f`。先看 `git status` 里有没有该目录。

**Q：报告在哪？**
默认 `audit-reports/`；用 `--md` 指定，多目标时加插件名后缀。

---

## 13. 诚实边界（工具覆盖不到）

- 可达性只算「邻近 + 一跳变量」，多层函数传递、经文件/Redis 中转看不到
- 运行时行为（远程下发授权、运行时下载执行、依赖链深层钩子）静态看不到
- 混淆只能报「存在」，解码后是签名算法还是后门载体，必须人读
- 闭源二进制只登记，不分析
- 社工类（钓鱼、冒充、二维码劫持）抓不到
- 不联网：上游 HEAD 变更、依赖 CVE 需另跑 `git ls-remote` / `npm audit`
- 增量模式只看改动行，改动行引用的旧变量/门禁可能不在范围内

**结论：工具负责「筛候选」，人负责「定性」。任何 `PASS` 都不等于「绝对安全」。**
