<!-- reviewed-by: independent-subagent (rev2: post-change) -->
# 独立审议 (REVIEW) — CI Lint 修复（wrangler types --check 口径不一致）

> 审议方：独立 `general-purpose` 子代理（rev1 与 rev2 为不同实例，均未参与实现）。
> 覆盖范围：`.github/workflows/ci.yml`（+26 行）、`VERIFICATION.md`。
> 结论：**PASS**，阻断项 0。rev2 覆盖追加注释与两处措辞修正后的状态。

## 改动摘要

在 `Lint` 步骤之前新增 `Seed CI env bindings`：用 heredoc 写入只含 5 个键、值为
`ci-placeholder` 的 `worker/.dev.vars`，使 CI 的 `wrangler types` 生成口径与已提交的
`worker/worker-configuration.d.ts` 对齐。另有 16 行注释说明根因与两条防回归约束。

## 阻断项

无。

## rev1 非阻断建议与本轮处置

| # | 建议 | 处置 |
|---|---|---|
| 1 | 自审头部「新增 1 step + 11 行注释」与实测不符 | 已改为「`+26` 行 = 16 行注释 + 1 个 step（9 行正文 + 1 个空行）」，rev2 复算一致 |
| 2 | 「推送 `63ac544` 后 CI 首次真正运行」口径不准 | 已改成「`63ac544` 本身无 run；Actions 打开后在其上的探测提交 `55a297d0` 触发首次 run；该 ref 的 ci.yml blob 为 `ad620e803b7e`，与修复前 HEAD blob 相同」，rev2 用 `gh api` 复核两处 blob 一致 |
| 3 | 后人可能「清理」掉 `SUPABASE_URL` 导致再红 | 已在注释里写死该约束 |
| 4 | 建议注明 wrangler 无跳过 `.dev.vars` 的开关 | 已写入注释 |
| 5 | `worker/.dev.vars.example` 只列 2 键，与 5 键不一致 | **未采纳（本轮）**：属另一个文件的文档同步，留作待办 |
| 6 | 三种替代方案评估 | 采纳其结论：保留现方案。理由见下 |

### 替代方案评估（rev1 实测结论，未采纳）

- **(i) 重新生成并提交 `worker-configuration.d.ts` 使其等于 CI 口径**：技术上可行，
  rev1 实测换成该口径后 `tsc --noEmit` 仍 **0 error**（密钥访问走 `JwtEnv` 等结构化局部类型，
  不依赖全局 `Env`）。但代价是 Env 契约里丢掉 5 个 secret 的文档性，且本地有 `.dev.vars`
  时同样会红，收益仅为「CI 少一个 step」，不划算。
- **(ii) 给 `wrangler types` 加 flag 忽略 dev vars**：wrangler 4.116.0 **无此开关**
  （`--help` 全量列出：`--env / --env-file / --env-interface / --include-runtime /
  --include-env / --strict-vars / --check`，`--env-file` 只能追加文件）→ 不可行。
- **(iii) 从 lint 拿掉 `wrangler types --check`**：会丢掉「声明文件与配置漂移」这道闸，
  而 B3 这类大改最容易踩，**不建议**。

## rev1 实际执行过的核查

### 三组对照（先备份真实 `worker/.dev.vars`，全程未打印任何值；实验后 md5 与备份一致并还原；每个实验后 `git checkout -- worker/worker-configuration.d.ts`）

| 条件 | `wrangler types` 生成结果 | md5 / 与 HEAD 比 | `--check` |
|---|---|---|---|
| a) 无 `.dev.vars` | 仅 `SUPABASE_URL: "https://PROJECT_REF.supabase.co"`（字面量）+ 2 个 DO 命名空间 | `94b70778…` ≠ HEAD `50efcfc8…` | **EXIT=1**（修复前必红的根因确认） |
| b) 5 键占位 | 5 个 `string` 键 | `50efcfc8…` **== HEAD blob** | **EXIT=0** `up to date` |
| c) 6 键（boss 本机真实） | 多一个 `SUPABASE_ACCESS_TOKEN` | ≠ HEAD | **EXIT=1** |

附加发现：

- **生成物只与键集有关、与值无关**——把 5 个值全换成 `x`，md5 仍一致。这意味着「少一个键」必崩。
- **CRLF 陷阱**：`git checkout` 还原后工作区 d.ts 为 CRLF（14720 个 CR）时 `--check` 假失败 EXIT=1；
  换成 LF 后同一命令 EXIT=0。CI 在 ubuntu 上检出 LF，不受影响。
- 把 `frontend/dist` 临时移走（模拟 CI 在 Lint 阶段尚无 dist）后 `--check` 仍 `up to date` EXIT=0
  → `[assets]` 缺失不影响 `wrangler types`。
- 端到端：占位 `.dev.vars` + LF 的 d.ts 下 `cd worker && npm run lint` **EXIT=0**，`tsc` 无输出。

### YAML 真实解析（非肉眼）

临时 `pip install --target /tmp/pylibs pyyaml`（不碰全局、不改仓库），`yaml.safe_load` 成功；
`jobs.verify.steps` 13 个，顺序 `… Install dependencies → Seed CI env bindings → Lint …`；
取出的 `run` 与期望脚本 `==` 判定 True，逐行列号全为 0、`EOF` 在列 0（`run: |` 列 8、内容列 10）。
该 step 的键只有 `['name','run']`。另把脚本落到临时沙箱 `bash` 执行 → EXIT=0，
产物正是 5 行 `KEY=ci-placeholder`、LF 结尾。

### 范围与副作用

- `git diff -- .github/workflows/ci.yml`：单个 hunk，`+17 −0`（rev1 时点），只在 Lint 前插入；
  顶层 `on/permissions/concurrency` 未在 diff 中。
- `scripts/security-check.mjs` 全文 60 行只有 `npm audit` + `govulncheck`，**没有任何
  git status / untracked 检查**；ci.yml 末尾 `git diff --exit-code` 只比 `supabase/` 与
  `worker/src/generated/`。且 `git check-ignore -v worker/.dev.vars` → `.gitignore:17:.dev.vars*`，
  该文件即使存在也不会出现在 status 里（实测生效）。
- `npm ci` 不依赖 `.dev.vars`；`npm run build` 的 worker 段同样含 `wrangler types --check`，
  因此这一步**同样被修好**；`generate-migrations.mjs` 不读 `.dev.vars`（全仓 grep 只命中 ci.yml 与注释）。
- `npm test` 不受影响：miniflare 夹具用 `new Miniflare({ bindings: runtimeSecrets, … })` 显式注入，
  构造器不会自动读 `.dev.vars`。
- 键清单比对：`worker-configuration.d.ts` 的 `__BaseEnv_Env` 恰好 5 个字符串键 + 2 个 DO 命名空间，
  `ProcessEnv` 的 `Pick<…>` 同 5 个 → 种子**不多不少正好 5 个，顺序一致**。
- `package-lock.json` 只有一份 hoisted `wrangler@4.116.0`（root 无 wrangler 依赖，
  workspaces = frontend/worker）→ CI 与本地同源、可复现。

### 自审真实性

8 条「已验证」逐条对得上（第 1 条 `gh run view 40299541754 --repo wendu121/cf-vps-monitor
--log-failed` 由审议方亲自跑过，失败步骤 = `Lint`，日志尾部为
`✘ [ERROR] Types at worker-configuration.d.ts are out of date…` + `exit code 1`）。
如实披露到位：明确写「未在 GitHub 上真实验证该修复」「本地是模拟 CI 通过」，
并主动写了「本地 Windows 的 `npm run lint` 仍会失败（CRLF + 第 6 个键）」。

## rev2 增量复核（追加注释 + 两处措辞修正后）

**1. YAML 仍合法、脚本字节未变**：PyYAML 解析成功，`steps` 13 个，
`steps[4]` = `Seed CI env bindings`，键仍为 `['name','run']`；`run` 值与期望**逐字节相等**
（181 字符），`EOF` 在列 0、结尾单个 `\n`、无 CRLF；位置 3 < 4 < 5
（`Install dependencies` 之后、`Lint` 之前）。

**2. 数字复算**：`git diff --stat` → `1 file changed, 26 insertions(+)`；`--numstat` → `26 / 0`
（0 删除）。分类：`#` 注释 **16** 行，其余 **10** 行（`- name:` / `run: |` / `cat` / 5 键 / `EOF` / 1 空行）
= 9 行正文 + 1 空行 → 与 VERIFICATION.md 表述完全对得上。

**3. blob 口径**：`git rev-parse HEAD:.github/workflows/ci.yml` 与
`gh api contents/.github/workflows/ci.yml?ref=55a297d0 --jq .sha` 均为
`ad620e803b7e4fc24197a9f8bf75dfa5bb994453` → 「`55a297d0` 的失败结论适用于本修复」成立。

**4. 改动范围**：`git status --short` 10 个 `M` + 2 个 `??`，本轮相关仅 `ci.yml` 与
`VERIFICATION.md`；其余 8 个 M + 2 个 `??` 确为 boss 的 CF Tunnel WIP，未被动。
ci.yml diff 仅 1 个 hunk、0 删除行 → 无从改到 `on`/`permissions`/`concurrency`。

**rev2 结论**：`PASS`，阻断项 0。

## 未复核项（两轮合并）

- **真实 GitHub CI 是否转绿**：两轮审议期间均未 push，无法验证。这条只能由推送后
  `gh run watch` 收口，是本次修复唯一算数的证据。
- **Lint 之后的步骤**：`build`（vite + build:migrations）、`npm test`（全仓 `node --test`
  + `go test`）、两个 `sudo` 权限步骤、`security:check`、`Check migration drift`
  在 CI 上的表现均未实测。
- **Actions 官方 schema 级校验**：环境无 actionlint，用 PyYAML 解析 + 沙箱真实执行，
  能证明缩进剥离与 shell 语义正确，但不等价于 GitHub 的 workflow schema 校验。
- **根目录完整 `npm run lint` 的 frontend 段**未重跑（`CFAssets.tsx` 是 boss WIP，
  跑出来不代表本轮）；作为替代，从 CI 失败日志确认 frontend 的 `tsc -p tsconfig.json --noEmit`
  在修复前就是通过的。
- **boss 的 CF Tunnel WIP 本身**（8 M + 2 ??）正确性不在本轮范围，未审。
- **非 Ubuntu runner / macOS 行为**未验证（workflow 仅配 `ubuntu-latest`，实际风险为零）。

## 遗留待办（非阻断）

- `worker/.dev.vars.example` 只列 `SUPABASE_SECRET_KEY` / `JWT_SECRET` 两键，与已提交
  d.ts 的 5 键不一致。建议补一句「增删键必须同步修改 ci.yml 的 `Seed CI env bindings`
  并重新生成 `worker-configuration.d.ts`」。
- 本地 Windows 的 `npm run lint` 仍会因 CRLF + 第 6 个键（`SUPABASE_ACCESS_TOKEN`）失败。
  若想让本地也绿，可考虑给 `.gitattributes` 加 `worker/worker-configuration.d.ts text eol=lf`
  并从本地 `.dev.vars` 摘掉多余键；属本地开发体验问题，不在本轮目标内。
