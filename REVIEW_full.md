<!-- reviewed-by: independent-subagent -->

# 独立审议报告 · site-monitor 功能完整移植（F1~F8）+ P7 迁移脚本

> 审议对象：`E:\工作站\cf-vps-monitor-src` 本次新增/修改代码、迁移 SQL、迁移脚本、部署文档
> 审议方式：逐文件 Read 原文 + 跨文件实证比对（未依赖记忆、未运行构建）
> 对照文档：`VERIFICATION_full.md`、`DEPLOY.md`

## ① 总体结论

**FAIL**（存在 1 项阻塞级缺陷 + 3 项 WARN）。

- 阻塞项：**F7 公开状态页前端请求路径与后端路由不匹配，页面必然 404**。
- 其余 F1~F6、F8、迁移脚本、SQL 正确性、安全、鉴权、RPC 一致性均 PASS；另有几处 WARN（非阻塞，建议修复）。
- 阻塞项定位精确、修复成本极低（单行/单文件改动），不影响其他 7 项功能落地质量。

---

## ② 逐项审查结果

### 2.1 SQL 正确性 —— PASS（含 2 项 WARN）

| 审查点 | 结论 | 证据 |
|---|---|---|
| `cfm_website_sla_report` 月度边界 | PASS（WARN 范围校验） | `6_site_monitor.sql:189-203`：`date_trunc('month', ...::date)` 得月初，`wc.checked_at < m_start + interval '1 month'` 覆盖整月 `[月初, 次月初)`，边界正确。WARN：`month` 仅由路由正则 `^\d{4}-\d{2}$` 校验（`ops.ts:26`），`'2026-13'` 这类非法月会穿透到 SQL `::date` 抛错（被路由 catch 转 502，灰度可接受，但建议路由层补月份范围校验）。另 `date_trunc` 依赖会话时区，若 Supabase 会话非 UTC 月边界会偏移（低概率，建议注明）。 |
| `cfm_website_consensus` 字符串拼接 `(p.window_minutes \|\| ' minutes')::interval` | PASS（安全） | `6_site_monitor.sql:239,245`：`window_minutes` 先经 `coalesce((input->>'window_minutes')::integer, 30)` 强转整数，再拼接，注入点被 `::integer` 截断，无法注入。路由侧 `ops.ts:54` 还做了 1~1440 钳制。input 虽称"内部"，但此写法因整数强转而安全。 |
| `cfm_ack_notifications` 正则校验 | PASS | `6_site_monitor.sql:343-346`：`jsonb_array_elements_text` 后 `where value ~ '^[0-9]+$'` 过滤，仅数字可进入 `::bigint`，无注入。 |
| `cfm_expire_notifications` hours 钳制 | PASS | `6_site_monitor.sql:360`：`least(greatest(coalesce((input->>'hours')::integer, 24), 1), 720)` 钳至 [1,720]。 |
| `cfm_sync_cf_domains` 单事务 upsert+删旧 | PASS | `6_site_monitor.sql:130-158`：单 plpgsql 函数内先 `on conflict do update` 再 `delete ... not exists(输入集)`，任一步异常整体回滚，不会留空表（修复了 clear+upsert 双 RPC 的原子性缺陷）。 |

### 2.2 安全 —— PASS

| 审查点 | 结论 | 证据 |
|---|---|---|
| 源码零明文 Token（`nsju_`） | PASS | Grep `nsju_` 于 `worker/src`：**零命中**。Token 仅经 `resolveCfCredentials`（`cf-client.ts:72-81`）从 `.dev.vars`(env) 或 settings 表取用，绝不进代码。 |
| `worker/.dev.vars` 被 git 忽略 | PASS | 根 `.gitignore:16-17`：`.dev.vars*` 忽略、`!.dev.vars.example` 仅放示例。实测磁盘存在 `worker/.dev.vars`（本地密钥，未提交）。符合预期。 |
| 所有新 RPC `revoke public/anon/authenticated` + `grant service_role` | PASS | `6_site_monitor.sql:371-424`：11 个新 RPC 逐一 `revoke all ... from public/anon/authenticated` + `grant execute ... to service_role`。 |
| F7 `/status` 免鉴权且不泄露隐藏站点 | PASS（路径见 2.5 阻塞项） | `public.ts:1643` 在 `publicRoutes`（无鉴权中间件）下；`index.ts:322` 仅 `app.route('/api', publicRoutes)`。数据来自 `cfm_public_websites`（`4_rpc_api.sql:4493` 含 `input_include_hidden boolean`），匿名请求 `include_hidden=false` → 隐藏站点及其 `url` 不返回（`StatusPage.tsx:99` 对空 url 显示"地址已隐藏"）。不泄露 `hide_url` 站点。 |
| `opsRoutes` 全部在 `/api/admin/*` 之下（JWT+CSRF） | PASS | `index.ts:331` 的 `/api/admin/*` 中间件统一做 `verifyAdminToken`+`verifyAdminCsrfToken`；`index.ts:400` `app.route('/api/admin/ops', opsRoutes)`。所有 ops 子路由均受保护。 |

### 2.3 后端逻辑 —— PASS（含 2 项 WARN）

| 审查点 | 结论 | 证据 |
|---|---|---|
| `dispatchNotification` `case 'none'` 仍 `return false` 不中继 | PASS | `notification-dispatch.ts:262-264`：`case 'none'` 先 `record(...'disabled'...)` 再 `return false`；而 `enqueueAgentMailRelay` 在 `switch` 之后（`notification-dispatch.ts:275`），故 `none` 分支提前返回、**不会**入队中继。语义正确。 |
| `enqueueAgentMailRelay` 不阻断主链路 | PASS | `notification-dispatch.ts:230-250`：内部 `try/catch` 包裹 `deps.enqueueRelay`，失败仅记 health 事件、不抛出；外层 `dispatchNotification` 照常返回 `sent`。`index.ts:509-515` 经 `deps.enqueueRelay` 注入，无循环依赖。 |
| Cron `runCfAssetSync` 节流（取最近一条无 error 的 run） | PASS（WARN 失败重放） | `index.ts:862-867`：`listCfSyncRuns` 由 SQL `ran_at desc` 排序（`6_site_monitor.sql:122`），`find(r => !r.error)` 取最近成功记录；首次运行 `runs` 为空 → 直接同步（正确）。**WARN**：Cron 路径在 `syncCfAssets` 抛错时**不写** run 记录（`index.ts:869-875` 仅在成功后 insert；cf.ts:89 的写 error 逻辑只属于手动 `/sync`）。若 CF 凭据存在但鉴权持续失败，`runs` 恒无成功记录 → 每个 Cron 周期都重试并记 error 日志（"刷屏"），与 `index.ts:851-852` 注释"未配置时静默跳过"仅覆盖缺凭据场景。建议失败也写一条 `error` run 以参与节流，或在 creds 校验失败时缓存。 |
| `syncCfAssets` 空输入跳过 | PASS（WARN 残留） | `cf-sync.ts:86`：`domainRows.length > 0` 才 `syncCfDomains`。注释明确"空输入跳过以防误删全表"——是有意防御（防瞬态空响应误清空）。**WARN**：若 CF 账号**确实**没有任何 Worker/Pages 自定义域名（仅用 `*.workers.dev`/`*.pages.dev`），`domainRows` 恒空 → 旧 `cf_domains` 行永不清理，F3 域名清单可能显示陈旧条目。建议区分"接口成功返回空"与"接口失败/无权限返回空"（如按 `getProjectCustomDomains` 是否成功判断），失败时才跳过。 |

### 2.4 前端 —— FAIL（1 阻塞）+ PASS/WARN

| 审查点 | 结论 | 证据 |
|---|---|---|
| 4 个新页面 `apiFetch` 路径 | PASS | `api.ts:11-17` `withApiBase`：非 `/api` 开头路径自动加 `/api` 前缀。故 `/admin/ops/sla`、`/admin/ops/websites/:id/diagnose`、`/admin/ops/notifications`、`/admin/ops/notifications/ack` → `/api/admin/ops/...`，与 `ops.ts` 路由完全对应（`ops.ts:36,50,77,110,123,135,158`）。 |
| `StatusPage` 用 plain fetch（公开端点无 CSRF） | 设计正确 | `StatusPage.tsx:46` 用原生 `fetch`（无凭据、无 CSRF），符合公开端点约定。 |
| **`StatusPage` 请求路径** | **FAIL（阻塞）** | `StatusPage.tsx:46` 请求 `/api/public/status`，但后端实际注册为 `publicRoutes.get('/status', ...)`（`public.ts:1643`）挂载于 `/api`（`index.ts:322`）→ 真实路径是 **`/api/status`**。`/api/public/status` 无任何路由匹配 → **404**，公开状态页永远加载失败。此路径同时与文档矛盾：作者自审 `VERIFICATION_full.md:29,50`、`DEPLOY.md:110` 均写"GET `/api/public/status`"。**修复方向（二选一）**：① 后端改 `publicRoutes.get('/public/status', ...)` 使路径变为 `/api/public/status`（推荐，与文档+前端一致）；② 或前端改 `fetch('/api/status')`。 |
| SLA 页 Recharts + month 切换 | PASS | `SLA.tsx:5` 引入 recharts，`SLA.tsx:72-78` 构建 `chartData`、`136-144` 渲染 `BarChart`；`SLA.tsx:26-30,103-105` `shiftMonth` 切月并触发 `useEffect` 重载。逻辑自洽。 |
| 死代码 / 未用导入 | WARN（轻微） | `diagnose.ts:22` `unsafe_host` 在 `DiagnoseReasonCode` 联合与 `SUGGESTIONS` 中声明，但 `diagnoseSite` **从不返回** `unsafe_host`（无内网/回环拦截逻辑），属死分支；同时 `diagnose.ts:49,278` `http.tls_days_left` 字段恒为 `null`（TLS 剩余天数未被计算）。构建通过、无功能影响，建议清理或补全。其余页面导入均有使用。 |

### 2.5 迁移脚本 —— PASS

| 审查点 | 结论 | 证据 |
|---|---|---|
| RPC 参数名与真实签名一致 | PASS | `migrate-site-monitor.mjs:161` `cfm_create_website_monitor`→`{input_monitor: payload}`，签名 `4_rpc_api.sql:2537` `cfm_create_website_monitor(input_monitor jsonb)` ✓；`:185` `cfm_record_website_check`→`{input_check:{...}}`，签名 `:1462/3959/4213` `cfm_record_website_check(input_check jsonb)` ✓；`:216` `cfm_insert_audit_log`→`{input_user, input_action, input_detail, input_level}`，签名 `:3786-3790` `cfm_insert_audit_log(input_user text, input_action text, input_detail text, input_level text default 'info')` ✓。`input_level` 为可选，传与不传均可。 |
| 入参健壮性 | PASS | 脚本对 name/url 空值与协议校验（`:127-142`）、`clampInt` 钳制区间（`:150-157`）、返回 id 合法性校验（`:163-167`）齐备；逐站点 try/catch 不中断整体。与既有 RPC 契约一致。 |

### 2.6 与既有代码一致性 —— PASS

- RPC 命名：全部 `cfm_*` 前缀，与既有 `cfm_cf_domains`/`cfm_website_sla_report` 等一致。
- 分层：worker 侧 `routes/*` → `db/supabase-api/client.ts`（`getSupabase*`/`syncSupabase*` 包装）→ `db/queries.ts` 适配，与既有 website/audit 调用链同构；`enqueueRelay` 用依赖注入避免 `notification-dispatch` 直接 import db（防循环依赖），符合现有分层。
- 鉴权：复用 `/api/admin/*` JWT+CSRF 中间件，无旁路。
- `ScheduledRunContext` 已含 `env: Bindings`（`index.ts:448`），`runCfAssetSync` 直接读 `context.env`，与既有 `getScheduledClientRowsByIds` 等用法一致。

---

## ③ 必须修复的阻塞项清单

1. **[FAIL] F7 公开状态页路径不匹配（404）**
   - 后端：`worker/src/routes/public.ts:1643` `publicRoutes.get('/status', ...)`（挂载后实为 `/api/status`）。
   - 前端：`frontend/src/pages/StatusPage.tsx:46` `fetch('/api/public/status')`。
   - 文档：`DEPLOY.md:110`、`VERIFICATION_full.md:29,50` 均记为 `/api/public/status`。
   - **修复**：将 `public.ts` 路由改为 `publicRoutes.get('/public/status', ...)`（路径即 `/api/public/status`，与文档+前端一致）；或反向改前端。改后端一行即可让 F7 端到端打通，且 `cfm_public_websites` 已支持 `input_include_hidden`（`4_rpc_api.sql:4493`），隐藏站点过滤照常生效。

---

## ④ 可选改进建议（非阻塞）

1. `ops.ts:26` SLA `month` 仅正则校验，建议补月份范围校验（`01-12`），避免 `'2026-13'` 触发 SQL `::date` 抛错（虽被 catch 转 502，但体验差）。
2. `index.ts:869-875` Cron 同步失败时应写入一条 `error` run（或缓存失败态），以免 CF 鉴权持续失败时每个 Cron 周期重放并刷 error 日志。
3. `cf-sync.ts:86` 空输入跳过的"防误删"与"真无域名导致旧数据残留"存在权衡，建议按 `getProjectCustomDomains` 是否成功来区分是否跳过清理。
4. `diagnose.ts` 清理死代码：`unsafe_host` 分支（或补全内网/回环拦截逻辑）、`tls_days_left` 恒 null 字段（或接入真实 TLS 剩余天数计算）。
5. `cfm_website_sla_report` 依赖会话时区做 `date_trunc('month', ...)`，若 Supabase 会话非 UTC 月边界会偏移，建议在 SQL 显式 `AT TIME ZONE 'UTC'` 或文档注明。
6. `VERIFICATION_full.md:31` 称 `ScheduledRunContext 增 env` 已落地，`index.ts:448` 已确认存在——自审无误；但同文档把 F7 路径记为 `/api/public/status` 与代码不符（即本文阻塞项），自审未捕获，建议部署前补一次"前端实际请求路径 vs 后端路由"的 grep 核对。

---

### 附：审计方法声明
- 全部 14 个指定文件 + `4_rpc_api.sql`、`worker/src/db/supabase-api/client.ts`、`frontend/src/utils/api.ts`、`frontend/src/contexts/AuthContext.tsx`、根 `.gitignore` 均经 Read 原文比对。
- RPC 签名比对：用 Grep 在 `4_rpc_api.sql` 取真实 `create or replace function` 签名，与 `client.ts` 调用参数、`migrate-site-monitor.mjs` 传参三方交叉验证，全部一致（除上文阻塞项的路由路径外）。
- 未修改任何源文件，仅产出本报告。
