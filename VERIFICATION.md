# 交付前自审 (VERIFICATION) — 修复 CI Test 失败（手工验证脚本被单测 glob 误收）

> 本轮改 **2 个文件**：`docker/validate/test-login.mjs` → `docker/validate/verify-login.mjs`
> （git 识别为 rename），`docker/validate/README.md`（+12）。净 `+19` 行，无业务代码改动。
> 上一轮（CI Lint 修复，commit `7ea0012`）的 VERIFICATION/REVIEW 已被本文件取代，
> 原文可从 `git show 7ea0012:VERIFICATION.md` / `git show 7ea0012:REVIEW.md` 取回。
>
> **不在本轮范围**：boss 的 CF Tunnel WIP（8 个已修改 + 2 个未跟踪）仍未提交。

## 最终结果（CI run 40308866676，已推送 `3f3760a`，已实测）

> 本节是在推送后按 `gh run view` 的真实结果回填的，用于收口下文「未验证项」中的 CI 条目。

| 步骤 | 结果 |
| --- | --- |
| Seed CI env bindings / Lint / Build | ✅ success |
| **Test** | ✅ **success**（本轮目标达成，`test:js` 与 `test:go` 均通过） |
| Installer service account permissions | ✅ success（首次真实执行） |
| Agent root collector permissions | ✅ success（首次真实执行） |
| Agent data race check | ✅ success（首次真实执行） |
| **Dependency and toolchain security** | ❌ **failure** |
| Check migration drift | ⏭ skipped（被上一步失败中断） |

**结论：本轮目标「让 Test 转绿」已达成**，且三个此前从未执行过的 sudo/race 步骤全部通过。
CI 整体仍红，但红点已从「本轮能修的问题」推进到**下一层既有问题**（见下节）。

## 新的失败点：依赖漏洞（既有问题，非本轮引入）

`Dependency and toolchain security` 跑 `scripts/security-check.mjs`，它有两道硬门槛：
`npm audit` 必须 **total === 0**（`--audit-level=low --include=dev`，连 info 都算失败），
之后 `govulncheck` 必须恰好输出 `No vulnerabilities found.`。

CI 在**第一道**就失败。用官方 registry 实测 `npm audit --include=dev` 得到
**10 个漏洞（4 moderate + 6 high）**：

| 包 | 严重度 | 直接依赖 | 修复方式 |
| --- | --- | --- | --- |
| undici | high | 否（overrides→miniflare） | ≥7.30.1（当前 pin 7.29.0） |
| sharp | high | 否（overrides→miniflare） | ≥0.35.5（当前 pin 0.35.4） |
| source-map-js | high | 否 | ≥1.2.2 |
| vite | high | 是 | 升 patch |
| wrangler | high | 是 | 4.152.0（经 miniflare 传递） |
| hono | moderate | 是 | 升 patch（4.12.4–4.13.10 有洞） |
| tailwindcss | moderate | 是 | **需 4.3.3（major，3→4）** |
| postcss-selector-parser | moderate | 否 | ≥7.1.6 |
| postcss-nested | moderate | 否 | 跟随上游 |
| miniflare | high | 是（dev） | 跟随 sharp/undici |

**与本轮改动无关，已用 git 核实**：
`git diff --stat 7ea0012 HEAD -- package.json package-lock.json */package.json */package-lock.json agent/go.mod agent/go.sum`
输出为空；三个提交累计同样为空。即这些漏洞是从上游 v2.0.3 继承的既有问题。

**`govulncheck` 的真实结果在 CI 上仍未知**：它在第一道就短路，从未执行。
本地试跑报「10 个 Go 标准库漏洞」，但**该结果不代表 CI** ——
`agent/go.mod` 要求 `go 1.26.8`，CI 按 `go-version-file` 装 1.26.8，
而本地只有 `go 1.25.1`，标准库落后一轮，漏洞是从本地旧标准库扫出来的。

**未处理原因**：完整修复需要 `tailwindcss 3→4` 这类 major 升级，
会影响前端构建与样式，属独立议题；且 boss 的 CF Tunnel WIP 正在改 worker 侧。
本轮不擅自推进，已向 boss 报告并给出选项。

## 上一轮修复的实际效果（CI run 40303900639，有据可查）

推送 `63ac544..7ea0012` 后 CI 首次完整跑到 Lint 之后，逐步结论：

| 步骤 | 结果 |
| --- | --- |
| Seed CI env bindings | ✅ success |
| Lint | ✅ **success**（上一轮修复的目标达成） |
| Build | ✅ success |
| Test | ❌ **failure** |
| Test 之后的 5 个业务步骤 | ⏭ skipped（因 Test 失败而中断） |
| Post Setup Go / Post Setup Node | ⏭ skipped（job 失败的连带结果） |

具体被 skip 的 5 个业务步骤：`Installer service account permissions`、
`Agent root collector permissions`、`Agent data race check`、
`Dependency and toolchain security`、`Check migration drift`。

`Lint` 转绿即证明上一轮「播种 5 键 `.dev.vars`」的根因判断正确。**但 Test 随之暴露出
一个既有隐患** —— 它不是本轮引入的，只是此前 CI 从未真正跑到 Test。

## 问题

```
node:internal/modules/run_main:107
[TypeError: fetch failed] { [cause]: Error: connect ECONNREFUSED 127.0.0.1:8787 }
✖ docker/validate/test-login.mjs (58.427594ms)
```

汇总：`tests 997 / pass 967 / fail 1 / skipped 29`。**唯一失败项就是它**，其余 996 项全绿。

## 根因（实测，非推断）

1. 根 `package.json` 的 `test:js` 是**裸跑** `node --test`，不传任何路径参数：
   ```json
   "test:js": "node --test"
   ```
2. Node test runner 在未指定文件时按内置 glob 递归发现测试，
   其中一条规则是 `**/test-*.?(c|m)js` —— 它把**任意目录**下以 `test-` 开头的文件都收进来。
3. `docker/validate/test-login.mjs` 正好命中该规则。但它的内容与单元测试无关：
   ```js
   const BASE = 'http://127.0.0.1:8787';
   const loginRes = await fetch(`${BASE}/api/login`, { ... });
   ```
   它要求本地已有 `wrangler dev` 在 8787 监听。CI 里没有，于是顶层 `await fetch` 直接抛
   `ECONNREFUSED`，进程以 exitCode 1 退出。
4. 该文件由 commit `933db42`（「新增 Docker 端到端验证编排」）引入，**全仓库零引用**：
   `grep -rn "test-login" --include=*.md --include=*.mjs --include=*.json --include=*.yml`
   无任何命中；`docker/validate/README.md` 原文也从未提到它。属于当时顺手放入的调试脚本。

判定：**文件命名撞上了测试发现规则**，而非脚本本身有缺陷。

## 修法

1. `git mv docker/validate/test-login.mjs docker/validate/verify-login.mjs`
   —— 脱离 `test-*` 前缀，脚本保留、能力不丢。
2. 文件头补 7 行注释，写明「这是需要真实 8787 服务的手工脚本，不是单元测试」，
   并解释为何不能改回 `test-*` 名字。
3. `README.md` 补「验证 admin 登录与会话」一节（怎么跑）+ 一条反改名警告。
   原文完全没提这个脚本，补文档同时把约束写在**最可能被读到的地方**。

## 已验证（实测）

- **判别力实验（决定性）**：在隔离临时目录放两个内容为 `throw new Error("<名> COLLECTED")`
  的文件，裸跑 `node --test`：
  ```
  子目录/test-login.mjs   → "# Error: test-* COLLECTED"   tests 1 / fail 1
  子目录/verify-login.mjs → 无任何输出（未被收录）
  ```
  证明「改前缀即脱离默认 glob」，而非靠推测。
- **唯一性排查（口径已修正）**：不靠手写正则猜，而是用 Node 自带的
  `path.matchesGlob`（与 test runner 内部同一实现）逐条套用六条默认发现规则
  （`**/*.test.?(c|m)js`、`**/*-test.*`、`**/*_test.*`、`**/test-*.*`、
  `**/test.*`、`**/test/**/*.*`）枚举全部被 git 跟踪的文件：
  ```
  命中总数: 151
  非 *.test.* 命中: 1
    - frontend/test/helpers/production-module.mjs  <=  **/test/**/*.?(c|m)js
  ```
  即：150 个是真测试，**唯一**被误收的非测试文件是
  `frontend/test/helpers/production-module.mjs` —— 由 `**/test/**` 目录规则收录。
  **它今天无害**：该文件只有 `export` 定义、无顶层副作用与断言，被当作「零用例的
  测试文件」执行后判 pass，故不出现在失败列表。但同类风险客观存在：谁往它顶层加一句
  `await fetch(...)`，CI 就会以同样方式判红。本轮不改它（属独立议题，另见非阻断建议 7）。

  > 上一版本此处曾写「40 个文件 / 不存在第二个同类雷」，是按手写正则（漏掉
  > `**/test/**` 规则）统计的，**数字与结论均不准确**，已按上述 `matchesGlob`
  > 口径更正。第一版曾误记为 157，是把 `scripts/test-support/`、`worker/test-support/`
  > 下的 6 个 helper 也算了进来（它们的目录名是 `test-support` 而非 `test`，
  > 文件名也不以 `test-` 开头，**实际不会被收录**）。
- **引用完整性**：改名前 grep 确认零引用；改名后 `git status` 显示为
  `R  docker/validate/test-login.mjs -> docker/validate/verify-login.mjs`，无残留孤儿。
- **改动范围**：`git diff --stat docker/` = 2 files / +19 / −0（rename 不计行）。
  未触碰任何业务代码、测试代码或配置。
- **不影响 lint**：根 `lint` 只跑 `frontend` 与 `worker` 两个子包，
  `docker/validate/` 不在其扫描范围内。

## 未验证 / 需披露

- ~~真实 GitHub CI 是否转绿：未 push，无法验证~~ → **已收口**：推送 `3f3760a` 后
  run `40308866676` 实测 `Test` **success**，本轮目标达成；CI 整体仍红于
  `Dependency and toolchain security`（既有依赖漏洞，详见上方「新的失败点」一节）。
- **本地未能完成全量 `node --test`**：Windows 上跑 13 分 41 秒仍未结束
  （CI 同批 204 秒），本地缺 Docker / postgres 会让集成测试空等，继续跑无增量信息已终止。
  因此「本地全绿」**不作为**本轮结论依据；依据是 CI 日志中其余 996 项 already green
  ＋ 上述 glob 判别实验。
- ~~`test:go` 在 CI 上从未真正执行过~~ → **已实测通过**：run `40308866676` 的
  `Test` 步骤 success 覆盖了 `npm test` 全链（`test:js && test:go`），
  Go 侧 19 个 `_test.go` 首次在 CI 上跑通。
- ~~CI 上 Lint 之后的 5 个业务步骤仍未实测~~ → **已实测 3 过 1 挂 1 未跑**：
  两个 sudo 权限检查与 `Agent data race check` 均 success；
  `Dependency and toolchain security` failure（既有依赖漏洞）；
  `Check migration drift` 被上一步失败中断，**仍未实测**。
- **`security:check` 本地预演：曾因镜像不可用而失败，已定性。** 本地执行返回真实 EXIT=1，
  原因是 boss 的 npm 指向 `registry.npmmirror.com`，该镜像不支持
  `/-/npm/v1/security/audits/quick` 端点（404 NOT_IMPLEMENTED）。
  顺带核实脚本本身是 **fail-closed**（`requireSuccessfulScan` 抛错），
  不存在「扫描失败却放行」的假绿风险。**CI 上该步确实失败，但原因是依赖漏洞（见上），
  不是镜像问题** —— CI 用的是官方 registry。
  （注：首次用 `| tail` 读退出码读到的是 `tail` 的 0，属误判，已重测修正。）

- **`Check migration drift` 本地预演：预期通过。** 在 `git worktree` 的干净 HEAD 下
  执行 `node scripts/generate-migrations.mjs` → `Generated 10 Supabase migrations.`，
  随后 `git diff --quiet -- supabase/ worker/src/generated/` 返回 **0（无漂移）**，
  与 CI 该步的 `git diff --exit-code` 判定口径一致。
  本地 `git status` 会多出一个 ` M`，那是 Windows `core.autocrlf=true`
  （`.gitattributes` 只对 `*.sh` 声明 `eol=lf`）造成的行尾假象，`git diff` 归一化后为空；
  CI 为 Linux/LF 环境，不存在此现象。
- **`Check migration drift` 的本地预演带有 WIP 污染**：在主工作区（非干净 worktree）执行
  `npm run build:migrations` 时，boss 未跟踪的 `supabase/migrations/10_cf_tunnel_domains.sql`
  也被收进 `worker/src/generated/supabase-migrations.ts`（新增 1 条 version 记录，排在 11 之前）。
  这是 boss 提交 WIP 时本就需要的一步，**未纳入本次提交**；CI checkout 的是 HEAD
  （无该未跟踪文件），生成口径不受影响。

- **Local Windows CRLF** 会让 `wrangler types --check` 假失败，与本轮改动无关，
  已在上一轮记录中说明。

## 独立审议的采纳情况（REVIEW.md，独立子代理，未参与实现）

结论 **PASS，阻断项 0**。其 8 条非阻断建议处理如下：

| # | 建议 | 处理 |
| --- | --- | --- |
| 1 | 更正「40 个文件 / 不存在第二个同类雷」的事实错误 | **已采纳**。改用 `path.matchesGlob` 实测为 151，并点明唯一误收者 `production-module.mjs` |
| 2 | 「其余 6 步 skipped」改为「5 步 + 2 post 步」 | **已采纳**，并列出被 skip 的 5 个业务步名称 |
| 3 | 提交前 `git add -A docker/validate VERIFICATION.md REVIEW.md` | **已采纳**（rename 已在 index，注释与 README 仍在工作区，`git status` 为 `RM`） |
| 4 | 披露段点名 `test:go` 从未在 CI 执行 | **已采纳**，已写入披露段 |
| 5 | README 输出描述精确化 | **已采纳**，并补「未拿到 cookie 时后两步跳过」 |
| 6 | README 警告补 `**/test/**` 目录规则 | **已采纳** |
| 7 | 处置 `frontend/test/helpers/production-module.mjs` | **本轮不做**。它当前 0 断言空跑、判 pass，无网络无抛错，不构成现存故障；移动目录会牵动现有测试的 import，属独立议题。已记录为后续待办 |
| 8 | README 写明端口 8787 的来源 | **已采纳** |

另：审议员用 `npx -y node@24`（v24.22.1，与 `ci.yml` 的 `node-version: '24'` 同主版本）
复现了 glob 行为，与我在本地 v22.22.2 上的实验结论一致，两个版本口径相同。

