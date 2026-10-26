<!-- reviewed-by: independent-subagent -->
# 独立审议 (REVIEW) — 依赖漏洞修复 + 显式安全基线（rev2）

## 审议方与覆盖范围

- **审议方**：reviewer-security，独立第三方，未参与本轮实现。本文件是对 rev1（`continue-on-error` 方案，判 REJECT/2 阻断）的复审。
- **基线**：`HEAD = c26f91a` + 未提交工作区。
- **覆盖**：`ci.yml`、`agent/go.mod`、`scripts/security-check.mjs`、`scripts/security-baseline.json`（新增）、
  `scripts/security-gate.test.mjs`、`package.json`、`package-lock.json`、`worker/package.json`、`VERIFICATION.md`，
  以及旁证 `release-agent.yml`、`README.md`、`agent/ping-platform.test.mjs`。
- **方法**：全部结论来自实测，不采信 VERIFICATION.md 的自述：
  - 用 `runSecurityChecks({ run, log, baselinePath })` 的注入点做**离线探针**（8 组用例，不跑真实扫描、不联网）；
  - `yaml@2.5.1` 严格解析 ci.yml；
  - **判别力实验**：临时把 `continue-on-error` 塞回 ci.yml → 跑测试 → 还原并校验 sha256；
  - 全仓 grep Go 版本 pin；`pkg.go.dev` 核对 advisory 修复版本。
- **未做**（按要求）：未跑 `npm run security:check`（慢 + 需网络）、未跑根级 `node --test`、未跑 `vite build`、未 push。
- **副作用声明**：判别力实验是对 `ci.yml` 的唯一临时改动，已用备份还原，sha256 前后一致
  （`3406a8fa…05a8`），还原后复跑 11/11 通过。其余临时文件均在仓库外。

---

## 阻断项闭环复核

### B1（rev1）：记录步骤把失败原因写死，并彻底遮蔽 govulncheck —— **已闭环**

| 复核点 | 结果 | 证据 |
| --- | --- | --- |
| ci.yml 已无 `continue-on-error` | ✅ | `grep -n "continue-on-error"` 仅命中 `ci.yml:122` 的**注释**（「处理方式不是 continue-on-error」），步骤本体没有该键 |
| 已无 `Record outstanding dependency findings` | ✅ | `grep -n "Record outstanding"` 无输出；YAML 解析出 **13** 个 step（rev1 是 14，右移的正是被删的那一步） |
| 已无 `id: security` | ✅ | `grep -n "id: security"` 无输出；security 步骤为 `ci.yml:139-140`：`- name: Dependency and toolchain security` / `run: npm run security:check`，无 id、无 if、无 coe |
| 「归因写死」问题是否消失 | ✅ | 承载该断言的那个 step 已被整体删除，仓库内不再有硬编码的失败归因文本 |
| `security:check` 是否真能跑到 govulncheck | ✅ | 代码侧：`security-check.mjs:128-144` 在 npm 分支里只有 `log()`，**没有任何 return/throw 早退**，唯一出口在 `:159`/`:167`，都在 go 之后。实测侧：探针 A 用真实审计报告走到末尾，日志顺序为 `npm audit: 4 known finding(s)…` → `govulncheck: no vulnerabilities found.`，**两个扫描器都执行了** |

结论：rev1 的「对 govulncheck 既不阻断也不可见」不再成立 —— 现在是硬阻断且必然被执行。

### B2（rev1）：发布门禁静默失效，且测试为其背书 —— **已闭环**

| 复核点 | 结果 | 证据 |
| --- | --- | --- |
| ci.yml 的 security 是硬步骤 | ✅ | `ci.yml:139-140`，无 `continue-on-error`；YAML 解析确认 `jobs.verify.continue-on-error = undefined`（job 级也没有） |
| release-agent 复用链仍成立 | ✅ | `release-agent.yml:22` `uses: ./.github/workflows/ci.yml`、`:25` `needs: verify`；该文件本轮**未被修改**（不在 `git status` 里） |
| 新测试存在且断言正确 | ✅ | `security-gate.test.mjs:200+` 新增 `AUD-20 the reusable CI gate keeps security as a hard step, not continue-on-error`，解析 ci.yml 后对 security 块 `assert.doesNotMatch(/continue-on-error/)` |
| **判别力实验（我自己复现）** | ✅ | 临时加 `continue-on-error: true` → `node --test scripts/security-gate.test.mjs` → **`not ok 11`**，`# pass 10 / # fail 1`，报错文案正是「security must stay blocking…」；还原后 **11/11 pass** |
| 旧的「假背书」测试是否还误导 | ✅ | rev1 那条 `AUD-20 the reusable CI gate blocks same-checkout Agent publishing when security fails` 仍存在（进程内 fixture，不读 coe），它现在**与真实工作流重新一致**了 —— 因为门禁确实恢复了硬阻断。不再是假保证 |

结论：门禁恢复为真门禁，且有一个非恒真的测试守着它。rev1 的 B1/B2 均已闭环。

---

## 新方案的核实记录

### 1. 基线缺失 / 损坏是否真 fail closed —— **证实**

读 `loadBaseline`（`security-check.mjs:60-88`）：文件读不到或 `JSON.parse` 失败即 `throw`；`npmAdvisories`/
`goVulnerabilities` 非数组即 `throw`；advisory id 不合 `^GHSA-[a-z0-9-]+$` 即 `throw`；severity 不在
`info/low/moderate/high/critical` 即 `throw`。且 `loadBaseline` 是 `runSecurityChecks` 的**第一句**
（`:120`），在跑任何扫描器之前 —— 基线坏了连扫描都不会开始。

实测（注入式探针）：

| 用例 | 结果 |
| --- | --- |
| 基线文件不存在 | **BLOCK**：`security baseline is missing or unreadable (…/nope.json)` |
| 基线文件内容不是 JSON（拿 .mjs 冒充） | **BLOCK**：`security baseline is missing or unreadable (…/security-gate.test.mjs)` |

测试侧也有覆盖：`security-gate.test.mjs` 里「a missing or malformed baseline fails closed」用例跑这两种输入并断言 `status === 1`。**证实。**

### 2. 「advisory 不在基线就失败」能否被 `via` 字符串逻辑绕过 —— **当前依赖树下不会漏判，但存在一条理论上的静默通道**

判定依据是 `collectAdvisories`（`:96-113`）：只把 `via` 里的**对象**（以及形如 GHSA 的字符串）收进
`found`，纯包名字符串跳过。理论上的担心是：`postcss-nested` / `tailwindcss` 的 `via` 全是字符串，
会不会因此被整体漏判。

**实测结论：不会。** 用真实审计报告跑探针 A，`collectAdvisories` 得到 **6 个 advisory id**，
正好等于基线的 6 条；而 `postcss-nested`（`via: ["postcss-selector-parser"]`）与
`tailwindcss`（`via: ["postcss-nested","postcss-selector-parser"]`）之所以安全，是因为它们指向的
**叶子包 `postcss-selector-parser` 自己在报告里有对象形式 `via`**（`GHSA-rj75-hqrm-r3gf`），
已被基线收录。也就是说：字符串 via 只是「指路」，真正的判定发生在叶子节点上，而 npm 的报告
必然包含叶子节点。**这条逻辑成立。**

**但我发现了一条没被守住的通道**（下方建议 2）：如果某次报告里 `counts.total > 0` 却一个
advisory id 都解析不出来（例如 npm 改了 `via.url` 的格式，`split('/').pop()` 拿不到 GHSA），
`found.size === 0` → `unbaselined` 为空 → **直接放行**，并且日志还会打印
`npm audit: no vulnerabilities found.`。我构造了这份输入（`total=1`，`via` 全为包名字符串），
探针 F 实测 **PASS（放行）**，日志为「no vulnerabilities found.」+「baseline entries no longer
reported」。这是 fail-open 的边角，虽然当前 npm 输出能正确解析（6 个 id 全中），但作为安全门禁
值得补一行断言。

### 3. `npm audit` 退出码放宽到 {0,1} 会不会把 registry 故障当干净扫描 —— **证实有矛盾检测，不会被骗**

`readAuditReport`（`:31-58`）逐层设防：

| 输入 | 行为 |
| --- | --- |
| `status` 既非 0 也非 1（如 2、null） | `throw`（`:36-39`） |
| stdout 不是 JSON / 被 HTML 截断 | `throw`（`:42`） |
| `auditReportVersion !== 2`、`report.error` 存在、缺字段、分项之和 ≠ total | `throw`（`:44-49`） |
| 包条目数与 total 一个为 0 一个不为 0 | `throw`（`:51-53`） |
| **`status === 1` 但 `total === 0` 且条目为空** | **`throw`**（`:54-56`，注释写明「refusing to treat that as success」） |

探针实测：`exit 1 + 干净报告` → **BLOCK**（`npm audit exited non-zero yet reported a clean scan`）；
`exit 2` → **BLOCK**。即 registry 故障 / 输出异常都不会被误当成干净扫描。**这条放宽是安全的。**

### 4. Go 版本升级是否安全 —— **改动本身安全；但全仓普查发现一处仍在钉 1.26.8 的文档**

| 检查 | 结果 |
| --- | --- |
| `agent/go.mod` 只改版本行 | ✅ `git diff` 仅 `-go 1.26.8 / +go 1.26.10`，无 require 变动 |
| `go.sum` 未变 | ✅ `git status --short agent/go.sum` 为空 |
| CI 自动跟随 | ✅ `ci.yml:34` 与 `release-agent.yml:45` 都用 `go-version-file: agent/go.mod`，无需改 workflow |
| 1.26.10 是否真存在 | ✅ 本机 module cache 已有 `toolchain@v0.0.1-go1.26.10.windows-amd64`（另有 1.26.8），说明本轮确实下载并执行过该工具链 |
| `GO-2026-6809` 的修复版本 | ✅ `pkg.go.dev/vuln/GO-2026-6809`：`crypto/x509`，`Affected: before go1.26.10`。与自审「Fixed in go1.26.10」一致，1.26.10 足够 |
| 其他钉死 1.26.8 的位置 | ⚠️ **`README.md:50`**：`GO_VERSION=1.26.8`（与 `agent/go.mod` 保持一致）—— 括号里的「保持一致」现在**是假的**；另 `agent/ping-platform.test.mjs:10` 硬编码了 `toolchain@v0.0.1-go1.26.8…/go.exe` 的绝对路径（既有代码，本轮未改） |
| Dockerfile / 安装脚本 | ✅ 全仓 `find -iname "Dockerfile*"` 无结果；`docker/` 下只有 `validate/`；`scripts/`、`agent/*.sh|ps1` 无其他 Go 版本 pin |

**判断**：`README.md:50` 应当在本轮一并改成 `1.26.10`。它不会让 CI 变红（CI 走 `go-version-file`），
也不会必然让 fork 部署失败（Go 默认 `GOTOOLCHAIN=auto`，会按 go.mod 自动下载 1.26.10），
但「与 agent/go.mod 保持一致」这句话现在是错的，而 README 正是 fork 用户的部署依据 —— 属于必改但非阻断。
`ping-platform.test.mjs:10` 是既有的本机特定路径回退（不存在就 fallback 到 `go`），且 auto toolchain
会兜住版本差，可不改；若要彻底干净，把它改成 `go` 或从 `go.mod` 读版本即可。

### 5. 自审是否诚实 —— **主要副作用披露到位，但有 2 处失准**

**到位的部分**（我认为这轮自审质量明显高于 rev1）：
- `VERIFICATION.md:9-13` 主动写明 rev1 被 REJECT 及原因，没有粉饰；
- `:56-58` 明确承认上一版「本地 10 条 Go 漏洞不代表 CI」的判断**是错的**，并给出用 `GOTOOLCHAIN=go1.26.8`
  复现的过程 —— 这是主动推翻自己的结论，属于高质量披露；
- `:137-140` 明确写了「基线是有意为之的『已知不良状态』，让 4 条遗留长期存在，代价是只靠 followUp
  跟踪、没有强制到期机制」。**「基线 = 长期容忍」这个副作用没有被隐瞒**；
- `:141-143` 主动披露 `requireSuccessfulScan` 的 stderr/stdout 合并是顺带修的既有缺陷、且**没有测试覆盖**。

**失准的地方**：
1. `VERIFICATION.md:128` 写「YAML：解析出 **14** 个 step」。实测 **13** 个（删掉 Record 步骤后应为 13）。
   这是从 rev1 抄下来的陈旧数字，与它自己第 6 行「+4 个测试」「删掉 Record」的叙述矛盾。
2. `VERIFICATION.md:31` 仍写「`miniflare` 与 `wrangler` 的 `via` 全是 `sharp` / `undici`」。
   实测（rev1 已核过）`wrangler` 的 `via` 是 `["miniflare"]`（二级链）。结论不变，但这个措辞错误
   已连续两轮未修。

这两条都不影响结论，但既然本轮的主题就是「修正上一版的错误判断」，建议一并改准。

### 6. 新方案有没有引入新问题 —— 发现 3 处，均非阻断

1. **基线只比对 advisory id，不比对 severity。** `:130` 只做 `baseline.npm.has(id)`。基线里存了
   `severity` 字段却从未拿它与实时报告比对。后果：某个已基线的漏洞被 GitHub 上调严重度
   （例如 `GHSA-rj75-hqrm-r3gf` 从 moderate 升为 high/critical），门禁**静默放行**。
   对一个设计上要长期存在的基线，这是现实风险。
2. **`total > 0` 但解析出 0 个 advisory 时会静默通过**（见上文第 2 点，探针 F 实证）。
3. **`goVulnerabilities` 机制实际不可达。** `requireSuccessfulScan`（`:11`）要求 `status === 0`，
   而 govulncheck 文本模式发现漏洞时以 **exit 3** 退出。我用「基线内含 `GO-2026-6809` +
   govulncheck exit 3」实测（探针 G）→ **BLOCK**，报错在 `govulncheck failed (exit 3)`，
   根本走不到 `:161` 的 id 比对。安全方向是 fail closed，没问题；但 JSON 里那个数组是个
   「看起来能用、实际不会生效」的旋钮，容易误导后来者（当前它是空数组，无行为影响）。

另记一条**既有**问题（本轮未引入）：`security-gate.test.mjs` 新测试只检查**步骤级**
`continue-on-error`，不检查 **job 级**（`jobs.verify.continue-on-error`）。后者同样能让门禁失效。
当前 job 级确实没有该键（已用 YAML 解析确认 `undefined`），但测试留了这个盲区。

### 7. 范围 —— **证实**

`git status --short` 共 17 M + 3 ??。拆分：

- **本轮 8 个 M + 1 个 ??**：`ci.yml`、`agent/go.mod`、`scripts/security-check.mjs`、
  `scripts/security-gate.test.mjs`、`package.json`、`package-lock.json`、`worker/package.json`、
  `VERIFICATION.md` + 未跟踪的 `scripts/security-baseline.json`（预期新增）。
- **我的 `REVIEW.md`**（本文件）。
- **boss 的 CF Tunnel WIP（8 M + 2 ??）**：`CFAssets.tsx`、`generate-migrations.mjs`、
  `test-support/postgres.mjs`、`migration-signatures.test.mjs`、`db/types.ts`、
  `supabase-migrations.ts`、`cf-client.ts`、`cf-sync.ts` + `supabase/migrations/10_cf_tunnel_domains.sql`、
  `worker/src/utils/cf-client.test.mjs`。

与 boss 声明的数量**逐一对上**，无混入、无越界。

---

## 阻断项

**阻断项 0。**

rev1 的两个阻断项均已实质闭环（不是靠改文档、而是靠改机制）：
B1 通过「删掉写死归因的步骤 + 恢复硬门禁 + 真修 Go 工具链」闭环；
B2 通过「恢复硬步骤 + 新增一条经我实测具备判别力的测试」闭环。
本轮新引入的问题均属加固范畴，不构成正确性缺陷，不阻塞合并。

---

## 非阻断建议（按优先级）

1. **基线加 severity 比对**（2~3 行）：`unbaselined` 之外，再对 `found` 中命中基线的条目比较
   `entry.severity` 与基线记录的 `severity`，实时更严重则失败并提示更新基线。基线既然要长期存在，
   这是它最有价值的一道保险。
2. **补一条断言堵住静默通道**（1~2 行）：`if (counts.total > 0 && found.size === 0) throw`，
   并在测试里加一个「total>0 但无 advisory 对象」的用例。
3. **`README.md:50` 的 `GO_VERSION=1.26.8` 改为 `1.26.10`**，或删掉「与 agent/go.mod 保持一致」
   这半句。建议本轮一并改 —— 一行的事，留着就是一处会误导 fork 用户的版本漂移。
4. **`security-baseline.json` 目前是未跟踪文件（`??`）**：提交时务必 `git add`。
   若用 `git commit -am` 会漏掉，届时 CI 会因「baseline is missing」fail closed（方向安全，但白跑一轮 CI）。
5. **测试补 job 级检查**：在已有的 ci.yml 断言里加一条 `assert.doesNotMatch` 于 `jobs.verify`
   块，堵住「把 continue-on-error 提到 job 级」的绕过路径。
6. **`goVulnerabilities` 要么实现要么删**：若短期内不打算放行 Go 漏洞，建议把该数组从 schema 里去掉
   （或加注释说明「govulncheck exit 3 会被 requireSuccessfulScan 先拦下，此数组目前不生效」），
   避免下一个人以为往里加 id 就能放行。
7. **基线 schema 建议强制 `blockedBy` 非空**：现在只校验 id 与 severity，`blockedBy`/`exposure`/`followUp`
   全靠自觉。加一条非空校验，能防止未来有人为了「让 CI 变绿」塞一个光秃秃的 id 进来 ——
   这正是基线方案最需要防的滥用路径。
8. **修正自审两处失准**：`VERIFICATION.md:128` 的「14 个 step」应为 13；
   `:31` 的「wrangler 的 via 全是 sharp/undici」应为「wrangler 的 via 是 miniflare，miniflare 的才是 sharp/undici」。

---

## 结论

**PASS** —— rev1 的两个阻断项都已从机制上闭环（硬门禁恢复、govulncheck 真修且必经、判别力经我独立复现），
基线方案 fail-closed 设计与 exit-code 矛盾检测均实测成立；剩余 8 项均为加固级建议，不阻塞合并。
