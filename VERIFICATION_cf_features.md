# VERIFICATION — site-monitor 功能移植（F1/F2/F3）+ CF 资产 UI

> 阶段：P1 首轮落地（F1 资产同步 / F2 一键运维 / F3 域名+SSL 的后端路由 + 管理 UI）
> 日期：2026-09-22
> 评审对象：本次新增/修改的代码与迁移

## 1. 构建校验（门禁第 1 关，实测）

| 检查 | 命令 | 结果 |
|---|---|---|
| 迁移生成 | `npm run build:migrations` | ✅ Generated 6（迁移 6 追加 5 个 RPC 后仍 6 文件） |
| Worker 类型检查 | `wrangler types --check && tsc --noEmit` | ✅ 0 错误 |
| 前端构建 | `tsc -b && vite build` | ✅ `dist/assets/CFAssets-*.js`（8.05 kB / gzip 2.87 kB） |

> 修复的 4 个 TS 未用变量告警：`CfAssetsSnapshot` 误导入、`CfCredentials` 误导入、`requireCredentials` 内 `database`/`startedAt` 未用。
> `requireCredentials` 改为 `async` 并从 Supabase `settings` 表取生产期凭据（dev 期仍走 env）。

## 2. 新增/修改文件清单

**新增**
- `supabase/migrations/6_site_monitor.sql` — 追加 RPC：`cfm_cf_domains` / `cfm_cf_sync_runs` / `cfm_sync_cf_domains(jsonb)`（单事务：upsert 输入集 + 删除旧行）/ `cfm_insert_cf_sync_run(jsonb)`，并对 service_role 授权。
- `worker/src/utils/cf-client.ts` — 完整 `CloudflareApi`（zones/workers/pages/domains/purge/dev-mode/rollback + `getZoneSslDaysLeft`）+ `resolveCfCredentials` 双路径。
- `worker/src/routes/cf.ts` — `GET /assets`、`GET /domains`、`GET /sync-runs`、`POST /sync`、`GET /zone/:id/dev-mode`（回显当前状态）、`POST /zone/:id/purge`、`POST /zone/:id/dev-mode`、`POST /worker/:name/rollback`，全部含审计日志。
- `frontend/src/pages/admin/CFAssets.tsx` — 资产总览 + 同步 + 域名 SSL 表（导出 CSV）+ Zone/Worker 一键运维。
- `frontend/src/pages/admin/adminMenu.tsx` — 新增「CF 资产」菜单项（Cloud 图标）。
- `frontend/src/App.tsx` — 懒加载路由 `/admin/cf`。

**修改**
- `worker/src/index.ts` — 导入并挂载 `cfRoutes` 于 `/api/admin/cf`。
- `worker/src/db/types.ts` — `CfDomain` / `CfDomainInput` / `CfSyncRun` / `CfSyncRunInput` / `CfAssetsSnapshot`。
- `worker/src/db/supabase-api/client.ts` — 5 个适配器函数。
- `worker/src/db/queries.ts` — 5 个包装函数。
- `worker/.dev.vars` — CF Token（git-ignored，不进代码）。

## 3. 功能正确性自检

- **凭据安全**：Token 仅在 `resolveCfCredentials` 解析，dev 期 env、生产期 settings 表；代码中无明文（已 `git check-ignore worker/.dev.vars` 确认）。
- **权限降级优雅失败**：`purgeCache`/`setDevMode`/`rollbackWorker` 遇 403 返回 `{ok:false, reason:'permission'}`，路由据 reason 返回 403 且前端 toast 报错；不静默、不伪装成功。
- **F1 同步逻辑**：实时拉取 → 单事务 RPC `cfm_sync_cf_domains`（先 upsert 输入集、再删除不在输入集的旧行，plpgsql 函数内整段事务；任一步异常整体回滚，绝不留空表）。按 `cf_account_id` 过滤本账户 zone；域名经 `matchZoneId` 后缀匹配 zone_id（已改为按 zone name 长度降序，最具体 zone 优先，修正嵌套 zone 误配）。
- **F3 SSL**：`getZoneSslDaysLeft` 读取 `/zones/:id/certificates` 最早到期天数，按 zone 聚合（≤12 次调用）；失败不再静默——`console.error` 留痕，返回 null 不阻断。
- **测试覆盖**：CF 实时接口（zones/workers/pages/certificates）此前已用 boss 的真实 Token 实测通过（12 zone / 7 worker / 4 page / 真实 SSL 可读）。

## 4. 待补 / 风险（未在本轮解决）

- **未做真实端到端联调**：`POST /sync` 写库、UI 渲染需在已部署 + 已连 Supabase 实例上验证（依赖 D6 Supabase 决策 + 部署）。本轮仅做到构建级验证。
- ~~**F2 开发模式当前状态未知**~~：已新增 `GET /zone/:id/dev-mode` 读取 CF 当前 dev-mode 值，前端在加载后并行拉取各 zone 状态并回显到 Switch，消除「点开却无变化」的误导（见第 4.1 节）。
- **F4 SLA 月报 / F5 深度诊断 / F6 多区域共识 / F7 状态页 / F8 agent-mail 中继**：本轮未涉及，按 DESIGN.md 计划在后续里程碑实现。
- **迁移 6 在数据库需重新 apply**：Supabase 用迁移系统，新增的 5 个 RPC 需随 `supabase db push` 或 Dashboard 执行后生效。

## 4.1 独立审议（REVIEW）WARN 修复记录

独立审议（见 `REVIEW_cf_features.md`，结论：PASS with WARN）提出的 4 项 WARN + 1 项 UX 已知限制，已全部修复并重新通过构建校验：

| # | WARN | 修复 | 验证 |
|---|---|---|---|
| ③#1 | sync 非原子（clear+upsert 两次 RPC，失败留空表） | 改为单事务 RPC `cfm_sync_cf_domains`（upsert + 删旧行，plpgsql 整段事务，回滚绝不空表）；迁移/RPC/适配器/queries/route 同步改造 | `build:migrations` Generated 6 ✅ |
| ③#2 | `matchZoneId` 嵌套 zone 误配 | 改为按 zone name 长度降序匹配，最具体 zone 优先 | worker lint ✅ |
| ③#3 | `getZoneSslDaysLeft` 静默吞错 | catch 内加 `console.error`，保留 null 降级 | worker lint ✅ |
| ③#4 | `getAdminSectionTitle` 缺 `/admin/cf` 分支 | 补 `if (pathname.startsWith('/admin/cf')) return 'CF 资产'` | frontend build ✅ |
| UX | dev-mode 初次不回显 | 新增 `GET /zone/:id/dev-mode` + 前端加载后并行回显 Switch | 三关全过 ✅ |

> `nsju_` 全仓零命中复核：Token 仍仅存于 git-ignored 的 `worker/.dev.vars`，未进代码。

## 5. 结论

门禁第 1 关（构建校验）通过，独立审议（REVIEW）WARN 已在本轮修复并复验。代码风格与既有 `cfm_*` RPC、`adminRoutes` 鉴权、Radix UI 一致。待 D6（Supabase 决策）+ 部署后，即可做真实端到端联调（sync 写库、UI 渲染）。F4~F8 按 DESIGN.md 计划在后续里程碑实现。
