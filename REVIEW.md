<!-- reviewed-by: independent-subagent -->

# 独立审议 (REVIEW) — 修复 CI Test 失败（手工验证脚本被单测 glob 误收）

## 审议方与覆盖范围

- 审议方：独立子代理（reviewer-ci-test），**未参与本轮任何实现**，仅在本机仓库做只读核查 + 隔离实验 + 拉取 CI 日志，然后撰写本文件。未修改任何业务代码。
- 覆盖范围：`docker/validate/` 的 rename 与两处文档/注释改动，以及 `VERIFICATION.md` 中的自审结论。
- 核查环境：Windows 11 / git bash；本地 `node v22.22.2`；另用 `npx -y node@24` 取到 **v24.22.1** 复现 CI 版本（`ci.yml:29` 为 `node-version: '24'`）。
- 时间点：`HEAD = 7ea0012`，工作区含本轮 3 项改动 + boss 的 CF Tunnel WIP（8 M + 2 ??）。

---

## 核实记录

### 1. 根因是否成立 —— **证实**

证据链三层，全部自证：

**(a) 脚本确实是裸跑**

- `package.json:15` → `"test:js": "node --test"`（无任何路径/glob 参数）
- `package.json:17` → `"test": "npm run test:js && npm run test:go"`
- `.github/workflows/ci.yml:78-79` → `- name: Test` / `run: npm test`

**(b) Node 默认 glob 确实含 `test-*` 前缀规则**

- Node v24 官方文档（`https://nodejs.org/docs/latest-v24.x/api/test.html`，"Running tests from the command line"）列出的默认模式为：
  `**/*.test.?(c|m)js`、`**/*-test.?(c|m)js`、`**/*_test.?(c|m)js`、**`**/test-*.?(c|m)js`**、`**/test.?(c|m)js`、`**/test/**/*.?(c|m)js`（另有对应 `.ts/.mts/.cts` 版本，`.tsx` 不在其中）。
- 自建隔离实验（`/tmp/nt24`，与 CI 同主版本的 node 24.22.1）：

  ```
  $ npx -y node@24 --test        # 目录: docker/validate/{test-login,verify-login}.mjs + test/helpers/helper.mjs
  ✖ docker\validate\test-login.mjs (245.2851ms)     ← 被收录并因顶层 throw 判红
  ✔ test\helpers\helper.mjs     (247.7544ms)
  ℹ tests 2 / ℹ pass 1 / ℹ fail 1     EXIT=1
  # 输出中 "verify-login" 出现 0 次
  ```

  同一实验在本地 node v22.22.2 下结论一致（`test-alpha.mjs`/`sub/test-beta.mjs`/`real.test.mjs` 被收，`verify-*` 全部不收）。

**(c) CI 现场与推论吻合**

`gh run view 40303900639 --repo wendu121/cf-vps-monitor`（headSha `7ea0012...`）实测步骤结论：

```
6 Seed CI env bindings: success   7 Lint: success   8 Build: success   9 Test: failure
10 Installer service account permissions: skipped  11 Agent root collector: skipped
12 Agent data race check: skipped  13 Dependency and toolchain security: skipped
14 Check migration drift: skipped
```

`--log-failed` 中的关键行：

```
[cause]: Error: connect ECONNREFUSED 127.0.0.1:8787
✖ docker/validate/test-login.mjs (58.427594ms)
test at docker/validate/test-login.mjs:1:1
ℹ tests 997 / ℹ pass 967 / ℹ fail 1 / ℹ skipped 29
```

与自审引用的数字、文件、错误完全一致。且该文件内**没有任何 `node:test` 导入或断言**（`grep -n "node:test|^test(|assert"` → 无命中），只是顶层 `await fetch(...)`（`verify-login.mjs:23`），所以它被执行 = 必然连 8787。根因判定成立：**命名撞上测试发现规则，不是脚本缺陷**。

### 2. 改动范围 —— **证实（附一个提交流程提醒）**

- 只看本次相关目录（HEAD → 工作区，含 staged + unstaged）：

  ```
  $ git diff HEAD --stat --find-renames -- docker/
   docker/validate/README.md                            | 12 ++++++++++++
   docker/validate/{test-login.mjs => verify-login.mjs} |  7 +++++++
   2 files changed, 19 insertions(+)

  $ git diff HEAD -M --summary -- docker/
   rename docker/validate/{test-login.mjs => verify-login.mjs} (76%)
  ```

  → 净 `+19 / −0`，与 VERIFICATION.md 自述一致；rename 被 git 正确识别（76% 相似度，`R` 记录，磁盘上已无 `test-login.mjs`，`docker/validate/` 仅剩 `verify-login.mjs`）。

- boss 的 WIP 未被混入：8 个 `M` 全在 `worker/`、`frontend/`、`scripts/`、`supabase` 相关路径，抽样 `worker/src/utils/cf-client.ts` 的 diff 是 `CfCustomDomain.via` / `CfDnsRecord` 的 CF 自定义域名与 DNS CNAME 补全，与 `docker/validate/` 无关；2 个 `??` 为 `supabase/migrations/10_cf_tunnel_domains.sql`、`worker/src/utils/cf-client.test.mjs`。本轮未触碰 `package.json`、`ci.yml`、任何 `worker/src` 或 `frontend/src`。

- 需注意（非缺陷）：**rename 已进 index，但 `+7` 注释与 `README +12` 还在工作区**（`git status --short` 第 3 行是 `RM` 而非 `R `）。若用不带 `-a` 的 `git commit` 直接提交，会只提交 rename、丢掉两处内容改动。提交前请 `git add -A docker/validate VERIFICATION.md REVIEW.md`。

- `VERIFICATION.md` 本身也被改写（162 行变动），属自审文档，不在「业务代码」范畴；但它与 `REVIEW.md` 会一起进 commit，故其事实性错误需要一并修（见下文）。

### 3. 改名的有效性 —— **证实**

- 逐条比对 Node 六条默认规则与 `verify-login.mjs`：不匹配 `.test.`、`-test.`、`_test.`、`test-*`、`test.js`、`test/` 目录——**一条都不命中**。
- 实验反证（node 24.22.1）：把 `throw new Error("verify-login COLLECTED -- BAD")` 放进 `docker/validate/verify-login.mjs`，裸跑 `node --test` 后输出里 `verify-login` 出现 **0 次**，进程失败只来自同目录的 `test-login.mjs`。改名前后的行为差异是确定的，不是推断。
- 该文件不落在任何 `test/` 目录下，因此也不会被 `**/test/**/*` 这条规则捞回。

### 4. 是否会漏掉真测试 —— **「无真测试被漏」证实；但自审的「不存在第二个同类雷」被推翻**

- 旧名引用面：全仓（不限扩展名、排除 `.git`/`node_modules`）`grep -rn "test-login"` 只命中 `verify-login.mjs:7` 一行注释和 `VERIFICATION.md` 自身的叙述，**代码/脚本/工作流零引用**；`grep -rn "docker/validate"` 也只命中 README 两行与历史 REVIEW 文档。因此改名不会让任何测试或 CI 步骤指向空路径。
- 该文件本身不含测试（无 `node:test`、无断言），改名不会减少有效断言数。
- **反证自审结论**：我按 Node 六条规则枚举全仓被 git 跟踪的文件，命中 **151 个**（rename 前为 152），其中**非** `*.test.*` 的并不止一个：

  ```
  命中文件总数: 151
  按规则分布: { '*.test.*': 150, 'test/**': 20 }
  非 *.test.* 命中的文件: [ 'frontend/test/helpers/production-module.mjs' ]
  ```

  `frontend/test/helpers/production-module.mjs` 是纯导出型 helper（`readProductionSource` / `productionModule` 等，无顶层副作用），它被 `**/test/**/*.mjs` 收进来，作为一个「0 断言的空测试」计 1 项并判 pass（我在 `/tmp/nt24/test/helpers/helper.mjs` 复现了这个现象：`✔ test\helpers\helper.mjs`，`tests 2`）。

  性质说明：它今天**不是雷**（无网络、无抛错，CI 里也是绿的），但它是同一类「非测试文件被单测收录」的实例。任何人往这个 helper 顶层加一句 `await fetch(...)` 或 `throw`，CI 就会以同样方式判红，且报错信息会指向一个「看起来不是测试」的文件。因此 VERIFICATION.md:74-76 的「命中的 40 个文件中只有 … 不是真测试 / 不存在第二个同类雷」是**事实性错误**（数字错、结论也不完整）。

### 5. 文档准确性 —— **基本证实，2 处小偏差**

- 端口/路径一致：`verify-login.mjs:10` `const BASE = 'http://127.0.0.1:8787'`；README 警告里写的 `127.0.0.1:8787` 与之相符（wrangler dev 默认 8787，`worker/wrangler.toml` 无 `[dev]` 覆盖，故默认即成立）。
- 请求序列一致：`verify-login.mjs:23-47` 依次 `POST /api/login` → `GET /api/me` → `GET /api/admin/clients`，README:53 的描述吻合。
- 偏差 A（表述不精确）：README:54 写「只打印状态码与用户名」，实际还打印 `setCookie=yes/no`、`code=`、`clients=N`（`verify-login.mjs:20,46-47`）。虽不泄露任何明文凭据，但与「只」字不完全对应。
- 偏差 B（覆盖不全）：README:56-58 只说默认 glob 会收录「`test-*.mjs`」，未提 `**/test/**/*` 这条同样会把非测试文件收进来的规则（正是第 4 条那个 helper 的成因）。对「怎么避免再踩」这个目标而言，提示是必要但不充分的。
- 另：`/api/me`、`/api/admin/clients` 只在拿到 cookie 时才请求（`verify-login.mjs:32`），README 用「依次打」概括，读者可能误以为无条件三步。

### 6. 披露完整性 —— **关键项诚实；3 处与实测冲突**

- **「CI 是否转绿」：诚实标注为未验证**（VERIFICATION.md:86-87「未 push，无法验证 … 本文件不预先宣称 CI 会绿」）。这条是全文最该被检验的一条，写法合格，没有夸大。
- 本地全量 `node --test` 未跑完、6 个后续步骤未实测、migration drift 预演被 WIP 污染（VERIFICATION.md:88-99）——**均属实且主动披露**。其中 drift 污染一项我核对过：`worker/src/generated/supabase-migrations.ts` 的 diff 确实插入了 `"version": "10_cf_tunnel_domains"` 且排在 `11_metric_availability` 之前，与自述一致。
- 冲突 1：`VERIFICATION.md:75` 的「40 个文件」→ 实测 151（见第 4 条）。
- 冲突 2：`VERIFICATION.md:20` 的「其余 6 步 skipped」→ 实测 Test 之后被跳过的工作流步骤是 **5 个**（`ci.yml` 的 83/88/110/116/119 行），另有 2 个 post 步骤（Post Setup Go / Post Setup Node）也是 skipped，凑不出 6。
- 缺口 1：`npm test` 是 `test:js && test:go`，此前 `test:js` 就挂了，`test:go`（`cd agent && go test ./...`，19 个 `_test.go`）在 CI 里**从未真正执行过**。本轮修好 `test:js` 后它会首次运行，是「CI 转绿」的另一个未知面；披露段只提了 Lint 之后的 5 个独立步骤，没点名它。
- 缺口 2：未提及 `test/` 目录规则与 `frontend/test/helpers/production-module.mjs`（见第 4 条）。

---

## 阻断项

**阻断项 0。**

代码侧改动（rename + 注释 + README）我找不到功能性缺陷：根因成立、改法直达根因、范围最小、rename 已被 git 正确识别、零引用残留、在 CI 同主版本 Node 上实验证明新名不再被收录。可以提交。

（`VERIFICATION.md` 的两处数字/结论错误列在下面第 1、2 条。它们不影响 CI 结果，但会和本 REVIEW 一起进同一个 commit，建议同批改掉，否则 commit 内自带矛盾证据。）

---

## 非阻断建议

1. **`VERIFICATION.md:74-76` 必须改述**（现为事实性错误）。建议替换为：
   > 用 `git ls-files` 按 Node 六条默认规则枚举全仓：命中 **151 个**（rename 前 152），其中 150 个是 `*.test.mjs` 真测试；**唯一**非 `*.test.*` 的命中是 `frontend/test/helpers/production-module.mjs`（被 `**/test/**/*.mjs` 收录，纯导出 helper，今天 0 断言空跑且判 pass，不构成当前雷，但同类风险仍在）。
2. **`VERIFICATION.md:20` 的「其余 6 步」→ 改为「其余 5 步 + 2 个 post 步骤」**，与 `gh run view` 实测一致。
3. **提交前 `git add -A docker/validate VERIFICATION.md REVIEW.md`**：rename 已在 index，`+7` 注释与 `README +12` 仍只在工作区，直接 `git commit` 会漏掉后者（`git status` 显示 `RM`）。
4. **在披露段点名 `test:go`**：`npm test` 后半段 `cd agent && go test ./...` 在 CI 中从未执行，推送后是新的未知面；建议写明「若 Test 步骤仍红，优先看 test:go 段」。
5. **README:54 精确化**：改成「只打印 HTTP 状态码、`setCookie` 有无、用户名 / 业务 `code` / clients 数量，不输出密码、token、cookie 明文」，并把「依次打三步」补一句「未拿到 cookie 时 `/api/me`、`/api/admin/clients` 会被跳过」。
6. **README:56-58 的警告补一条规则**：除 `test-*.mjs` / `*.test.mjs` 外，`test/` 目录下的任意 `.mjs` 也会被收录（当前 `frontend/test/helpers/production-module.mjs` 即此类）。
7. **处置 helper（择一，可后续单独做）**：把 `frontend/test/helpers/` 移出 `test/`（如 `frontend/testing/helpers/`），或在该文件头加一行「被单测 glob 收录，勿加顶层副作用」。不阻断本轮。
8. **可选**：`docker/validate/README.md:49-51` 明确写出端口（`wrangler dev` 默认 8787，脚本 `BASE` 硬编码 8787），避免有人用 `--port` 改了端口后脚本静默连错。

---

## 结论

**PASS** —— 根因（裸跑 `node --test` 的默认 glob 收录 `test-*.mjs`）已在 CI 同主版本 Node 上被独立实验证实，改名确实让脚本脱离收录范围，改动范围最小且未混入 WIP；仅 `VERIFICATION.md` 有两处数字/结论需在提交前改述，不影响 CI 结果。
