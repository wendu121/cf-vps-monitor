<!-- reviewed-by: independent-subagent -->
# 独立审议 (REVIEW) — 依赖漏洞修复 + 显式安全基线（rev4 · 整改复审）

- 审议对象：`c26f91a..dd68182`（重点 `dd68182`），工作区 HEAD = `dd68182`
- 审议员：reviewer-rev4（未参与实现）
- 环境：Windows / git bash / Node v22.22.2，npm 走 `--registry=https://registry.npmjs.org`
- 纪律：未执行 `git stash` / `checkout <branch>` / `reset` / `clean`，未删除任何文件，未在 `frontend/` 跑 `vite build`；所有实验在 `E:/工作站/_review-probe` 独立目录内进行
- 判断依据：以下全部为我本人跑出的输出，未采信提交者叙述

---

## 一、rev3 阻断项闭环复核

### 阻断 1（lock 用「删文件重生成」替代定点更新）→ ✅ 已闭环

`git diff --stat c26f91a -- package-lock.json`：

```
 package-lock.json | 268 +++++++++++++++++++++++++++---------------------------
 1 file changed, 134 insertions(+), 134 deletions(-)
```

268 行总量 / 134:134，与 rev3 要求的「270 行量级」一致（重生成版为 877 行）。

自己写的结构比对（`git show c26f91a:package-lock.json` vs 当前）：

```
lockfileVersion base/cur: 3 3
packages count base/cur: 358 358
added(1): [ 'worker/node_modules/hono' ]
removed(1): [ 'node_modules/hono' ]
version-changed count: 29
   node_modules/@img/sharp-darwin-arm64 0.35.4 -> 0.35.5
   ...（26 个 @img/sharp-* / @img/sharp-libvips-*）
   node_modules/sharp 0.35.4 -> 0.35.5
   node_modules/source-map-js 1.2.1 -> 1.2.2
   node_modules/undici 7.29.0 -> 7.30.1
```

29 项**全部**落在 sharp 全家（`sharp` + 26 个 `@img/*`）+ `undici` + `source-map-js`，与 rev3 的要求逐项吻合。hono 的 1 增 1 删是层级搬移（根 → `worker/node_modules`），不是新增依赖。

越界升级核查：

```
postcss          8.5.28 -> 8.5.28 SAME
nanoid           3.3.18 -> 3.3.18 SAME
wrangler         4.116.0 -> 4.116.0 SAME
frontend/node_modules/vite          8.0.16 -> 8.0.16
frontend/node_modules/rolldown      1.0.3  -> 1.0.3
frontend/node_modules/lightningcss  1.32.0 -> 1.32.0
vite/rolldown/lightningcss/tailwind 相关条目数: 11 版本差异数: 0
```

`postcss` 已回到 8.5.28、`nanoid` 已回到 3.3.18，`vite` / `rolldown` / `lightningcss` / `wrangler` 零变化 —— rev3 指出的两处「白送的升级」已彻底消除。

补充口径（比提交者描述更严）：按「任意字段变化」统计是 **30 个包**，第 30 个是 `worker`（其 `dependencies.hono` 由 `^4.13.7` 改成 `^4.13.14`），属预期内，不是隐藏漂移。

### 非阻断 1（`security-check.mjs` 部分映射 fail-open）→ ✅ 已闭环

代码层面（`scripts/security-check.mjs:127-182`）：`collectAdvisories` 现在返回 `{ found, unmapped }`，`runSecurityChecks` 在 `unmapped.length > 0` 时无条件抛错（早于基线放行判定），且 id 识别放宽为 `GHSA-[a-z0-9-]+|CVE-\d{4}-\d{4,}`。

我按 rev3 的原场景**自己写探针**（`E:/工作站/_review-probe/probe-failopen.mjs`，注入 `run`，走真实 `runSecurityChecks`）：

```
=== A 混合报告（基线项 + 无 id 的 critical） ===
exit=1
error: npm audit reported 1 advisory that could not be mapped to a GHSA/CVE id:
  mystery-pkg: critical — mystery-pkg notice-42 (https://example.invalid/security/notice-42)
Refusing to treat a partially unparseable report as clean.

=== B CVE-only 且已基线化 ===            exit=0
=== C 真实报告 6 条 id 全部基线内 ===    exit=0
=== D 新增未基线化 GHSA ===              exit=1（列出 GHSA-zzzz-yyyy-xxxx vite: high）
=== E 基线项被上调到 critical ===        exit=1（postcss-selector-parser: critical，baseline accepted moderate）
=== F 字符串 via 不被误判为 unmapped === exit=0
汇总: {"A_mixed":1,"B_cve_baselined":0,"C_real_all_baselined":0,"D_new_ghsa":1,"E_escalated":1,"F_string_via":0}
```

- rev3 的放行场景（A）现在 **exit=1** ✅
- 放宽到 CVE 后 CVE-only **能正常匹配基线**（B=0），不是一律失败 ✅
- 反向破坏检查：真实全基线报告（C）仍放行；`via` 为上游包名字符串时（F）不被误判为 unmapped；新增/提级仍阻断（D/E）✅

### 非阻断 2（VERIFICATION 三处失准）→ ⚠️ 部分改正，且引入了新的数字失准

| rev3 指出的失准 | 当前状态 | 证据 |
| --- | --- | --- |
| 「`npm ls` 无 extraneous」 | ✅ 已改正为「有 4 个 extraneous」 | 我实测 `npm ls --all \| grep -c extraneous` = **4**，明细 `@emnapi/runtime` / `@emnapi/wasi-threads` / `@img/sharp-wasm32` / `@tybys/wasm-util`，与文档完全一致 |
| 「binding 16 个」 | ✅ 该表述已消失，改为「误装检查」 | `grep binding VERIFICATION.md` 只剩 linux binding 落地/解析相关行 |
| 「npm 10 → 4」硬指标 | ⚠️ 「10 → 4」字样已撤回，但替换成了**同样不成立**的新口径 | 见下节「非阻断发现 1」 |

---

## 二、逐项核实结果

### 2.1 lock 定点更新（问题 1）

| 要求 | 实测 | 结论 |
| --- | --- | --- |
| packages 358→358 | `358 358` | ✅ |
| added/removed 各 1（hono 搬移） | `added(1) ['worker/node_modules/hono']` / `removed(1) ['node_modules/hono']` | ✅ |
| version-changed 29 且全为目标包 | 29，全部 `sharp`/`@img/*`/`undici`/`source-map-js` | ✅ |
| postcss 回 8.5.28、nanoid 回 3.3.18 | 均 SAME | ✅ |
| rolldown/lightningcss/vite/wrangler 零变化 | 11 个相关条目 0 差异 | ✅ |
| diff 在 270 行量级 | 268（134/134） | ✅ |

### 2.2 fail-open（问题 2）

见上「非阻断 1」：A/B/C/D/E/F 六个场景全部符合预期。新增的两条测试也确实走真实 `runSecurityChecks`（`fixture` 会 `import` 被测模块并注入 `run`），不是进程内桩。

### 2.3 VERIFICATION 准确性（问题 3）

**已与实测一致的**（我逐条复核）：
- 「`npm run security:check` → EXIT=0 / 2 known findings / 6 advisory id(s)」→ 我的实跑完全相同
- 「`security-gate.test.mjs` 16/16」→ 实跑 16/16
- 「13 个 step，`continue-on-error` 仅出现在第 122 行注释」→ 实测 13 个 step，全文 `continue-on-error` 仅 1 处且在注释里，`id:` 出现 0 次
- 「`npm ci --dry-run` EXIT=0」→ 实测 EXIT=0
- 「extraneous 4 个」→ 实测 4 个，名字一致
- 「Linux 真实安装 EXIT=0 + rolldown 解析到 binding-linux-x64-gnu + 无 win32/darwin 误装」→ 我在全新目录 `_review-probe/linuxinst` 用当前 lock 实跑，1m39s，EXIT=0：
  ```
  ls node_modules/@rolldown/            → binding-linux-x64-gnu
  -rw-r--r-- 21949232  .../rolldown-binding.linux-x64-gnu.node
  grep -E "win32|darwin" → 无 win32/darwin
  createRequire(frontend/node_modules/rolldown/package.json).resolve(...)
    → E:\...\_review-probe\linuxinst\node_modules\@rolldown\binding-linux-x64-gnu\package.json
  ```
- 「134/134 行、358→358、29 项、vite 8.0.16 未升」→ 全部属实

**仍失准 / 新失准**：见「四、非阻断发现」1~4（数字口径错、`@img` 拆分错、`resolved` 主机无误）。

### 2.4 回归（问题 4）

```
$ node --test scripts/security-gate.test.mjs
1..16
# tests 16
# pass 16
# fail 0
```

```
$ npm_config_registry=https://registry.npmjs.org npm run security:check
npm audit: 2 known finding(s), all covered by the baseline (6 advisory id(s)).
govulncheck: no vulnerabilities found.
EXIT=0
```

```
$ npm_config_registry=https://registry.npmjs.org npm ci --dry-run
EXIT=0
```

```
step 数: 13
continue-on-error 出现次数: 1   （第 122 行注释）
id: 出现次数: 0
```

四项全部通过。

### 2.5 未被发现的问题（问题 5）

- lock 中 `resolved` 主机：`{"registry.npmjs.org": 150}`，其余 2 条是 workspace 软链（`resolved: "worker"` / `"frontend"`），**无镜像泄漏**。
- 基线 6 条 id 与实跑严格一致、无多余放行：

```
real ids: 6 baseline ids: 6
GHSA-rj75-hqrm-r3gf baseline=moderate real=moderate pkg=postcss-selector-parser pkgMatch=true
GHSA-698v-4r3x-3vcv baseline=moderate real=moderate pkg=vite pkgMatch=true
GHSA-r825-w8mm-5pxw baseline=moderate real=moderate pkg=vite pkgMatch=true
GHSA-587h-7wmj-h5pm baseline=high     real=high     pkg=vite pkgMatch=true
GHSA-9jrq-w75r-8gcw baseline=low      real=low      pkg=vite pkgMatch=true
GHSA-rq7h-c2jc-7f22 baseline=moderate real=moderate pkg=vite pkgMatch=true
（无 extra / 无 missing）
```

  config 里 `overrides` 与 lock 解析结果自洽：`hono@4.13.14` 落在 `worker/node_modules/hono`，`worker.dependencies.hono = ^4.13.14`；`npm ls` 显示 `sharp@0.35.5 overridden` / `undici@7.30.1 overridden` / `source-map-js@1.2.2 overridden`。
- 未发现新的 fail-open；但发现一条**理论性残留**（非阻断 2）与两处**文档/注释口径错误**（非阻断 1、3）。

---

## 三、阻断项

无。

rev3 的唯一阻断项（lock 重生成）已用定点更新替换，并经我独立比对证实：358→358、1 增 1 删、29 项全部为目标包、`postcss`/`nanoid`/`vite`/`rolldown`/`lightningcss`/`wrangler` 零漂移、diff 268 行。fail-open 也已用我自写探针确认修复，且未反向破坏正常放行路径。

---

## 四、非阻断发现

### 1. VERIFICATION 的漏洞计数口径仍然是错的（第三次同类问题）

提交者撤掉了「10 → 4」，但替换成的新说法同样不成立：

- `VERIFICATION.md:36-39`「npm 侧改前改后**都是 6 条 advisory**…剩下 4 个包（vite 5 条 + postcss-selector-parser 1 条）」
- `VERIFICATION.md:84`「剩余 **4 条** npm 漏洞」、`:86`「逐条记录 **4 条** 遗留」、`:172`「遗留 **4 条**」
- `VERIFICATION.md:200`「npm advisory **6 条**（改前后**数量相同**）」
- `.github/workflows/ci.yml:131`「已修复（10 → 4 条根因）… 仍留在基线里的 **4 条**」
- `scripts/security-baseline.json:5`「继承了 **10 条** 依赖漏洞」

我对 `c26f91a` 的 lock 做离线 audit（`npm audit --package-lock-only --include=dev`，与门禁同一口径）：

```
=== c26f91a（改前） ===
total packages: 8  advisory ids: 22
[["hono",1],["miniflare",0],["postcss-selector-parser",1],["sharp",1],
 ["source-map-js",1],["undici",13],["vite",5],["wrangler",0]]

=== 当前（改后） ===
metadata: {"info":0,"low":0,"moderate":1,"high":1,"critical":0,"total":2}
adv ids: 6   （postcss-selector-parser 1 + vite 5）
```

即真实是 **22 条 advisory / 8 个受影响包 → 6 条 / 2 个包**（`undici 7.29.0` 单包就挂 13 条），基线文件里也确实是 **6 条**。因此「改前改后都是 6 条」「剩余 4 条」「10 条」全部不成立，`@img` 拆分也不成立（见下条）。这条错误方向上是**低估**了本轮修复效果，不影响门禁正确性，但属于治理文档的事实性错误，建议按 22 → 6、8 → 2（基线 6 条）统一改一遍，并同步 `ci.yml` 注释与 `security-baseline.json` 的 `$why`。

### 2. `@img` 平台包数量拆分错

`VERIFICATION.md:127` 写「29 ← **25 个 @img/sharp-* 平台包** + **2 个 sharp-libvips** + sharp + undici + source-map-js」，三项相加 25+2+1+3=31、内部也对不上 29。实测：

```
@img/sharp-* 总数 26 其中 libvips 10 平台包(非libvips) 16
```

正确拆分是 **16 个平台包 + 10 个 libvips + sharp + undici + source-map-js = 29**。同一错误在 `:137`「sharp 的 25 个平台包」重复出现。

### 3. 一处残留的理论性 fail-open：`via` 为字符串且指向报告外的包

`collectAdvisories` 只对「对象型 via」做 unmapped 判定，字符串型 via 被当作「漏洞属于别处」直接跳过，且不校验该包是否真的在报告里。我构造的反例（`_review-probe` 探针 G）：

```
报告 = { 基线内 moderate 一条 } + { ghost-holder: critical, via: ["ghost-pkg"] }
→ exit=0（静默放行）
```

真实 `npm audit` 输出中 `via` 字符串始终指向报告内存在的包（改前报告里 `miniflare via ["sharp","undici"]`、`wrangler via ["miniflare"]` 均成立），因此**当前不可达**，不构成实际放行；但作为纵深防御，建议加一条不变量：字符串 via 必须命中 `report.vulnerabilities` 的某个 key，否则按 unmapped 处理。

### 4. 门禁隐式依赖 registry 配置（已知、已披露，仅备注）

`security-check.mjs` 调 `npm audit` 时未传 `--registry`，本机全局 registry 为 npmmirror 时会 404 而 fail closed：

```
npm warn audit 404 Not Found - POST https://registry.npmmirror.com/-/npm/v1/security/audits/quick
```

GitHub Actions 默认 registry 为 npmjs，CI 不受影响；本地必须带 `npm_config_registry` 才能跑通，文档已多处说明。属既有行为，不阻断。

### 5. 测试编号重复（纯命名）

`security-gate.test.mjs` 里 16 条测试全部以 `AUD-20` 开头（新增两条也是 `AUD-20 ...`），无法靠前缀区分新旧用例，建议后续改用序号。

---

## 五、未验证

- **真实 GitHub CI 是否转绿**：未 push，无法验证。`Check migration drift` 与 `Agent data race check` 在本轮仍是首次真实执行（本地无 C 编译器）。
- **`vite build` EXIT=0**：按纪律不在 `frontend/` 内执行（会触发批量删除保护），未复验；`npm ci --os=linux` 真装成功只证明 lock 可安装性，不等于构建通过。
- **worker 532/532、frontend 150/150**：未复验。当前主工作区 `node_modules` 与入库 lock 已不同步（`npm ci --dry-run` 显示会 `postcss 8.5.31 => 8.5.28`、`nanoid 3.3.20 => 3.3.18`），且 `worker/src/utils/cf-client.ts` 存在他人未提交 WIP 和新增 `cf-client.test.mjs`，此时跑测试无法归因，故不复跑也不采信。
- **`tsc --noEmit` 0 错、Go `build/vet/test` 全绿**：同上原因未复验；Go 侧仅间接确认工具链可用（`govulncheck` 在门禁内实跑返回 `No vulnerabilities found.`）。
- **Linux 上实际跑测试**：只做了安装与 `@rolldown/binding-linux-x64-gnu` 解析验证。

---

## 六、结论

**PASS**（阻断 0）

- rev3 阻断 1（lock 重生成）：已改为定点更新，结构差异与 rev3 要求逐项吻合（358→358、1 增 1 删、29 项全为目标包、零越界升级、268 行 diff）。
- rev3 非阻断 1（fail-open）：已修，且我用自己的探针复现了原场景（exit=1），同时确认 CVE-only 可匹配、正常全基线报告仍放行、新增/提级仍阻断。
- rev3 非阻断 2（VERIFICATION 失准）：extraneous 与 binding 两项已改正；但漏洞计数口径仍错，并新增 `@img` 拆分错误（见非阻断 1、2），建议在本轮之后单独更正文档/注释，不必再为此阻塞功能整改。
- 回归项（16/16 测试、security:check EXIT=0 且 6 条 advisory、13 个 step 无 `continue-on-error`/无 `id`、`npm ci --dry-run` EXIT=0）全部通过；lock 无镜像泄漏，基线与实跑 6 条严格一致无多余放行。
