<!-- reviewed-by: independent-subagent -->

# REVIEW_CF_FIX — 独立代码审议（门禁 ③ REVIEW）

**变更集**：1 个源码文件 `worker/src/utils/cf-client.ts`（`getProjectCustomDomains()`）
**日期**：2026-09-23
**审议方式**：只读；所有结论均带本人独立实测的 file:line 与命令输出，未采信主代理结论。
**声明**：本次审议未修改任何源码、未 git commit、未部署。`.dev.vars` 中 `CF_API_TOKEN` 全程仅用于只读 GET，未在本文回显明文。

---

## 阻断问题（Blocking）

**无。** 逐条独立复现后，未发现任何阻断本变更合入的问题。根因修复正确且已被本人用 CF 真实 API 实证。

---

## 一、CF API 行为（独立复现，不采信自审）

用 `worker/.dev.vars` 的 `CF_API_TOKEN` / `CF_ACCOUNT_ID`（值不回显）直接打 CF API（纯只读 GET；本机 DNS 异常时用 node `fetch` 直连绕过）。

实测输出（本人运行，非转述）：

```
pages/projects?per_page=100        HTTP=400 code=8000024
pages/projects (no-param)          HTTP=200 items=4
workers/domains?per_page=100       HTTP=200 items=6
zones?status=active&per_page=200   HTTP=200 items=12
workers/scripts?per_page=200       HTTP=200 items=8
pages/projects/{name}/domains      HTTP=200 items=1   （sspro / katelyatv / hellotv / zh001tv 各 1）
pages/projects/{name}/domains?per_page=100  HTTP=400  （4 个项目全部）
zones/{hqa.kdns.fr}/ssl/certificate_packs?per_page=50  HTTP=403 code=9109
```

结论：
- **根因实证成立**：`/pages/projects?per_page=100` 确实返回 **HTTP 400 / code 8000024**（"Invalid list options provided. Review the `page` or `per_page` parameter."），不带参数则 **200 / 4 个项目**。主代理的根因判定属实。
- 该 400 在旧代码里被 `getProjectCustomDomains` 的外层 `catch {}` 静默吞掉 → `out.pages` 恒空 → `cf_domains` 只剩 worker 的 6 行。机制与自审描述一致，且被本变更的 L264-266 `console.warn` 堵住。
- **附带实证**：`pages/projects/{name}/domains`（逐项目域名接口）同样**不接受** `per_page`（带参 400），但现代码 L252 本就不传参，写法正确。
- **对照合法接口**：`/zones`、`/workers/scripts`、`/workers/domains` 传 `per_page` 均 200（合法）；`certificate_packs` 传 `per_page=50` 返回 403/9109 是**权限问题而非参数问题**（不是 8000024），故该 `per_page` 本身合法、非本次同类问题。

## 二、代码落盘事实（本人亲自读到的行号与内容）

`worker/src/utils/cf-client.ts` 当前（改后）：
- **L248**：`const j = await this.cfFetch(`/accounts/${this.accountId}/pages/projects`);` —— **确无 `per_page`**，本人 Read 实读。
- L244-247：新增 4 行 ⚠️ 注释，说明 Pages list 不支持任何分页参数、切勿加回。
- L252：`/accounts/${this.accountId}/pages/projects/${p.name}/domains`（不传参，正确）。
- L259-261：逐项目 `/domains` 的 catch 加 `console.warn(...)`。
- L264-266：外层 catch 加 `console.warn(...)`。

`git status --porcelain`（本人运行）：
```
 M worker/src/utils/cf-client.ts
?? VERIFICATION_CF_FIX.md
```
`git diff --stat`：`worker/src/utils/cf-client.ts | 16 +++++++++++-----  1 file changed, 11 insertions(+), 5 deletions(-)`。
`git diff` 全文确认改动仅为 L248 删参 + 注释 + 两处 catch 改 warn，**无其他逻辑改动**。

**listPages() 自相矛盾核对（L199-200）**：本人读 L200 `const j = await this.cfFetch(`/accounts/${this.accountId}/pages/projects`);`，确无参且带注释「Pages list 不支持 per_page（带则 400）」。**改前** `getProjectCustomDomains` L248 误传 `?per_page=100` 与 `listPages` 的注释确实自相矛盾；**改后**两者一致。矛盾已被消除，非文档疏漏，是真实疏漏。

## 三、类型检查（本人单跑 tsc）

```
"C:/Users/sfkj/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
  "E:/工作站/cf-vps-monitor-src/worker/node_modules/typescript/bin/tsc" --noEmit -p \
  "E:/工作站/cf-vps-monitor-src/worker/tsconfig.json"
→ 零输出，TSC_EXIT=0
```
**真实退出码 0**，与自审一致。已知 `npm run build` 中 `wrangler types --check` 因 `worker-configuration.d.ts` 环境指纹不符而失败，系**既有问题**，不计入本变更。

## 四、同类问题穷举（全量搜 per_page）

`worker/src` 全量 `per_page` 命中 7 处，全部在 `cf-client.ts`，逐一判定：

| 行 | 调用 | per_page | 实测 | 判定 |
|---|---|---|---|---|
| L148 | `/zones?status=active&per_page=200` | 200 | 200 | 合法 |
| L173 | `/accounts/{acc}/workers/scripts?per_page=200` | 200 | 200 | 合法 |
| L230 | `/accounts/{acc}/workers/domains?per_page=100` | 100 | 200 | 合法 |
| L248 | `/accounts/{acc}/pages/projects`（改后） | 无 | 200 | **正确（已修）** |
| L252 | `/accounts/{acc}/pages/projects/{name}/domains` | 无 | 200 | 正确 |
| L288 | `/zones/{id}/ssl/certificate_packs?per_page=50` | 50 | 403/9109（权限） | 参数合法 |

**结论：本变更之外无其他 `per_page` 误传。** Pages 系列（`pages/projects` 列表 + 逐项目 `/domains`）确实均拒绝 `per_page`，现全部不传参；`/zones`、`/workers/*` 合法。无误传残留。

## 五、反例 / 边界（分页截断）

- **实测无截断**：`/pages/projects` 不带分页参数一次性返回全部 4 个项目（`items=4`），与「Pages list 不接受分页参数、直接返回全量」的设计一致。
- **是否会在项目数很大时被默认截断：未证。** 本人在当前账号（4 项目）下未观察到截断，也**没有证据**证明 CF 对该接口存在硬上限或默认分页。此为**开放项**，不构成本次修复的缺陷；若未来项目数激增出现漏项，需另行确认 CF 该接口的实际上限。

## 六、回归风险（cf-sync.ts 消费段）

`cf-sync.ts` L63-73 消费 `customDomains.pages`。`out.pages` 有值后逐行核对：
- L63-72：对每个 pages 项目 push 一行，`zone_id = matchZoneId(d.hostname, zones.items)`、`ssl_days_left = null`。4 个 pages 项目各 1 域名 → **新增 4 行，合计 10 行**，与预期一致。
- **`matchZoneId`（L22-30）对 `pending` 域名**：按 zone 名后缀匹配，pending 域名（`hv.zhanghuan.ggff.net`、`zhangmengting.dpdns.org`）若父 zone 在 active zones 中即正常命中；**未命中则返回 `null`**（L29），后续 L76 `filter(Boolean)` 与 L82 `r.zone_id ?` 均对 `null` 安全。**无崩溃**。
- **`getZoneSslInfo` 对无 zone 域名**：`zone_id` 为 null 的行不进 L78 的 zone 聚合，L83 `info` 为 undefined，`ssl_days_left`/`ssl_source` 落 null（L84-86）。**优雅降级，无异常**。
- 2 个 `pending` 域名 SSL 可能回落 null / ct_log 估算 —— 与自审「未闭环项 #3」一致，属预期，需部署后肉眼确认不误导。
- **附带发现（非阻断）**：本次修复使原本**从未被执行**的逐项目 `/domains` N+1 循环（L249-262，串行 fetch）真正跑起来了。4 项目无碍；若未来 pages 项目很多，串行 N+1 会线性增加同步延迟。这是既有代码结构、非本变更引入的缺陷，记录在案。

## 七、安全

- **凭据外泄**：新增的两处 `console.warn`（L261、L266）仅打印项目名 `p.name` 与 `e.message`。`e.message` 来自 `cfFetch`（L132 `CF API: ${msg}`，`msg` 为 CF 服务端 error message 或 `HTTP ${status}`），**不含 token**；`p.name` 是 CF 项目名，非密。**无 token 落日志**。
- **字符串拼接注入**：warn 为 `console.warn` 字符串插值，非 `eval`/SQL/命令拼接，无注入面。
- 结论：**无安全回归**。

## 八、改动范围

`git status --porcelain` + `git diff --stat` 确认：本次仅 `worker/src/utils/cf-client.ts` 被修改（+11/-5）。`VERIFICATION_CF_FIX.md` 为未跟踪的**新文档**（非源码）。**除 `cf-client.ts` 外无其他源码被波及。**（本审议产生的临时探测脚本已清理，不残留。）

---

## 非阻断发现（对自审的勘误与提醒）

1. **自审改前行号略偏 1 行**：`VERIFICATION_CF_FIX.md` 二/三处引用改前 `L244`（误传 `per_page`）/`L248`（逐项目域名）。据 `git diff` hunk 头 `@@ -241,7` 推算，改前误传参行实为 **L243**、逐项目域名约 L246-247。改后行号（L248 正确取数、L261/L266 两处 warn）**与本审议实测一致、无误**。不影响根因结论，但文档改前行号不严谨。
2. **分页上限「未证」已被如实标注**：自审未对「不带参是否会被默认分页截断」下结论，本审议补充：当前账号实测无截断，但**无证据**证明无硬上限（见第五节）。此为开放项，非本修复缺陷。
3. **N+1 死循环被激活**：见第六节附带发现——修复后串行逐项目 `/domains` 真正执行，项目数大时会线性拖慢同步。记录在案，非阻断。
4. **`listZones` 三重过滤（L149-155）为既有设计取舍**：自审已如实声明「将来 paused/非 active zone 会静默消失，需 boss 决定」，非本变更范围，认同不阻断。

---

## 总体结论

**PASS_WITH_NOTES**

一句话理由：根因（`/pages/projects` 误传 `per_page` 触发 400/8000024 被静默吞掉致 Pages 域名整块丢失）被本人用 CF 真实 API 独立实证，修复（删参 + 两处 catch 留痕）最小且正确，tsc EXIT=0、无残留 `per_page` 误传、无安全回归、无其他源码波及；仅存 4 项非阻断记录（改前行号不严谨、分页上限未证、N+1 被激活、`listZones` 既有取舍）与「未部署 / 线上端到端未验」两项待 boss 在上线后闭环。
