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

## 四、非阻断发现（rev5 增量核验 · `633075c`）

> 本节为增量确认：只核 `633075c` 对上一轮非阻断项的更正，不重复全量复审。第一节「非阻断 2」的历史结论以本节为准。

### 0. 本次核验输出（原样）

```
$ grep -n "10 → 4\|25 个\|剩余 4\|遗留 4\|4 个包\|都是 6 条\|改前后数量相同" \
    VERIFICATION.md .github/workflows/ci.yml scripts/security-baseline.json
VERIFICATION.md:43:> **口径纠正（本条曾连错两次，这里留痕）**：我先前写过「10 条」「npm 10 → 4」
VERIFICATION.md:44:> 「改前改后都是 6 条」，全都不成立。…（纠错留痕）
VERIFICATION.md:221:  - 我先前的「10 条」「npm 10 → 4」「改前改后都是 6 条」**全部作废**。…（纠错留痕）
VERIFICATION.md:75:（升级后实际核对：报告里只剩 4 个包，`miniflare` / `wrangler` 已不在其中）。
（`.github/workflows/ci.yml`、`scripts/security-baseline.json` 已无命中）
```

```
$ node -e "JSON.parse(fs.readFileSync('scripts/security-baseline.json'))"
JSON 合法: ok
npmAdvisories 条数: 6
ids: GHSA-rj75-hqrm-r3gf,GHSA-698v-4r3x-3vcv,GHSA-r825-w8mm-5pxw,GHSA-587h-7wmj-h5pm,GHSA-9jrq-w75r-8gcw,GHSA-rq7h-c2jc-7f22
goVulnerabilities: []
--- $why 拼接 ---
本仓从上游 kadidalax/cf-vps-monitor v2.0.3 继承了 22 条依赖 advisory（8 个受影响包；其中 undici 7.29.0 一个包就挂 13 条。可用 git log 核对：移植期间的提交从未改动 package.json / package-lock.json / go.mod / go.sum）。origin 项目的 npm audit 要求 total === 0，因此这些继承漏洞会让整条 CI 长期卡死，连后置的 Check migration drift 步骤都从未真正执行过。…（后续段落不变）
```

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

### 1. 漏洞计数口径（22/8 → 6/2）→ ✅ 已在 `633075c` 闭环

新数字与我上一轮独立测得的完全一致（我此前用 `c26f91a` 的 lock 离线跑 `npm audit --package-lock-only --include=dev`，得到 `{"moderate":2,"high":6,"total":8}`、22 条 id、逐包 `hono(1) miniflare(0) postcss-selector-parser(1) sharp(1) source-map-js(1) undici(13) vite(5) wrangler(0)`；`undici` 明细我逐条核过 13 条带 URL 的 advisory）：

| 位置 | 现在的写法 | 与我的实测 |
| --- | --- | --- |
| `VERIFICATION.md:41` 标题 | 「npm 22 条 advisory / 8 个包 → 6 条 / 2 个包」 | ✅ 一致 |
| `VERIFICATION.md:43-58` 口径纠正段 | 改前 `{moderate:2,high:6,total:8}` + 22 条 id + 逐包拆分；改后 6 条 / 2 包 | ✅ 逐项一致（含 `undici(13)`） |
| `VERIFICATION.md:106-107` 基线段 | 「6 条遗留 advisory（vite 5 + postcss-selector-parser 1，对应 2 个包）」 | ✅ 与 baseline 文件的 6 条一致 |
| `VERIFICATION.md:193` 小节标题 | 「基线里的 6 条为什么接受」 | ✅ |
| `VERIFICATION.md:217-223` 三、已验证 | 稳定口径 = advisory id 集合：22 → 6；`total` 仅受影响包数、不可当指标 | ✅ 与我用 `--include=dev` 和默认参数两次测得的 22 一致 |
| `.github/workflows/ci.yml:130-131` | 「已修复 4 个根因包（改前 22 条 / 8 个包 → 改后 6 条 / 2 个包）」「undici 7.29.0 一个包挂 13 条」 | ✅ |
| `.github/workflows/ci.yml:135-136` | 「仍留在基线里的 6 条 advisory（vite 5 + postcss-selector-parser 1，共 2 个包）」 | ✅ |
| `scripts/security-baseline.json` `$why[0..2]` | 「继承了 22 条依赖 advisory（8 个受影响包；其中 undici 7.29.0 一个包就挂 13 条…）」 | ✅ |

`grep` 复核：`ci.yml` 与 baseline 里已无「10 → 4」「25 个」「4 条」「4 个包」类旧口径；`VERIFICATION.md` 仅剩 :43/:44/:221 三行命中，均为**显式标注为「作废/先前写错」的纠错留痕**（见本节第 6 条判定）。

**但仍残留 1 处同族旧数**：`VERIFICATION.md:75` 仍写「报告里只剩 **4 个包**」。我对两份 lock 都做过离线 audit，改后都是 **2 个受影响包**（`postcss-selector-parser` + `vite`）：

```
改后（当前 lock）: metadata {"moderate":1,"high":1,"total":2}
改后（828f68c 重生成版 lock，对照）: metadata {"moderate":1,"high":1,"total":2}
```

同一文档 `:217` 也写着「改后 `{total:2}` / 6 条 id」，故 :75 属**文档内自相矛盾**，应为「只剩 2 个包」。这是一句话的残留，不是新错误方向，但既然本轮主题就是纠数字，建议顺手改掉（不影响门禁、不阻塞）。

### 2. `@img` 拆分（16 + 10）→ ✅ 已在 `633075c` 闭环

```
$ node -e '…统计 version-changed…'
changed total 29
@img/sharp-* 总数 26 其中 libvips 10 平台包(非libvips) 16
```

- `VERIFICATION.md:148` 现写「16 个 `@img/sharp-*` 平台包 + 10 个 `sharp-libvips` + sharp + undici + source-map-js」→ 16+10+1+1+1 = **29**，与实测一致 ✅
- `VERIFICATION.md:158-159` 表格现写「sharp 的 16 个平台包」「sharp 的 10 个 libvips 包」→ ✅
- 旧的「25 个」「2 个 libvips」已全部消失 ✅

### 3. 「字符串型 via」披露 → ✅ 准确，未夸大也未掩盖

`VERIFICATION.md:303-310` 的披露与我的探针逐点吻合：

| 披露内容 | 我的核验 |
| --- | --- |
| 只对对象型 `via` 做 unmapped 判定，字符串型被跳过且不校验包是否在报告里 | ✅ 与 `collectAdvisories` 实现一致（`security-check.mjs:127-148`） |
| 构造 `{基线内 moderate} + {ghost-holder: critical, via:["ghost-pkg"]}` → `exit 0` | ✅ 我的探针 G 复现，结果完全相同 |
| 真实 npm 的字符串 via 始终指向报告内存在的包（`miniflare via ["sharp","undici"]`、`wrangler via ["miniflare"]`） | ✅ 我在 `c26f91a` 的离线 audit 里核到这两条，成立 |
| 当前不可达、未修、留作后续；建议加「字符串 via 必须命中 `report.vulnerabilities` 的 key，否则按 unmapped 处理」 | ✅ 定性正确：这是纵深防御缺口，不是现实放行路径；未把这处理解成「已修」 |

唯一可补的措辞（非必须）：披露里「实测 `exit 0`」用的是构造报告 + 注入 `run`，可注明「非真实 npm 输出」，以免后来人误读为线上可复现。

### 4. registry 隐式依赖 / 测试编号 → ✅ 已如实披露

`VERIFICATION.md:311-314` 补的两条与我上一轮观察一致：`security-check.mjs` 未传 `--registry`（本机 npmmirror 会 404 且 **fail closed**，我复跑确认过是 `npm error audit endpoint returned an error` 而非假绿）；16 条测试同前缀 `AUD-20`。无夸大。

### 5. 纠错留痕的恰当性 → ✅ 恰当

`:43-58`、`:217-222` 两处留痕都做到了：明确写「先前写过什么 / 为什么不成立 / 现在的实测值是多少」，且把作废说法放在引号里并以「全部作废」收口，不会被误读成现行结论。与上一轮「把错数当结论」相比，这种留痕是可审计的，应当保留。

一处纯措辞出入：`:43`「本条曾连错两次」与 `:220`「第三次修正，前两次都写错了」在计数叙述上略有差异（前者按「口径段被改过两次」、后者按「错法有三种」），属叙述角度不同，不影响任何事实判断，无需改。

---

## 五、未验证

- **真实 GitHub CI 是否转绿**：未 push，无法验证。`Check migration drift` 与 `Agent data race check` 在本轮仍是首次真实执行（本地无 C 编译器）。
- **`vite build` EXIT=0**：按纪律不在 `frontend/` 内执行（会触发批量删除保护），未复验；`npm ci --os=linux` 真装成功只证明 lock 可安装性，不等于构建通过。
- **worker 532/532、frontend 150/150**：未复验。当前主工作区 `node_modules` 与入库 lock 已不同步（`npm ci --dry-run` 显示会 `postcss 8.5.31 => 8.5.28`、`nanoid 3.3.20 => 3.3.18`），且 `worker/src/utils/cf-client.ts` 存在他人未提交 WIP 和新增 `cf-client.test.mjs`，此时跑测试无法归因，故不复跑也不采信。
- **`tsc --noEmit` 0 错、Go `build/vet/test` 全绿**：同上原因未复验；Go 侧仅间接确认工具链可用（`govulncheck` 在门禁内实跑返回 `No vulnerabilities found.`）。
- **Linux 上实际跑测试**：只做了安装与 `@rolldown/binding-linux-x64-gnu` 解析验证。

---

## 六、结论

**PASS**（阻断 0）—— 文档纠错已闭环

- rev5 增量核验范围：`633075c` 对 `VERIFICATION.md` / `.github/workflows/ci.yml` / `scripts/security-baseline.json` 的计数更正。
- 数字全部与我独立测得的 **22 条 advisory / 8 个受影响包 → 6 条 / 2 个包**、**16 平台包 + 10 libvips（=29）** 一致；三处文件的旧口径已清除，仅保留两处显式标注的纠错留痕（判定为恰当）。
- `security-baseline.json` 仍是合法 JSON、`npmAdvisories` 仍为 6 条（id 与实跑严格一致）、`goVulnerabilities` 为空；`$why` 拼接后语句通顺、语义正确（22 条 / 8 包 / undici 13 条）。
- 因改了 baseline 与 `ci.yml`，重跑门禁：`node --test scripts/security-gate.test.mjs` **16/16**；`npm_config_registry=https://registry.npmjs.org npm run security:check` **EXIT=0**，日志仍为 `2 known finding(s) … (6 advisory id(s))` + `govulncheck: no vulnerabilities found.`。
- 「字符串型 via」披露准确：定性为未修/当前不可达/留作后续，与我探针结果一致，无夸大或掩盖。
- 唯一残留：`VERIFICATION.md:75` 仍写「报告里只剩 4 个包」（实测 2 个，与同文档 `:217` 的 `{total:2}` 自相矛盾）。属一句话残留，建议后续顺手更正；不影响门禁正确性，不构成阻断。

> 本文件第一~三节与第五节为 rev4 全量复审的原始记录，未作改动；第四节、第六节为 rev5 增量核验结果。
