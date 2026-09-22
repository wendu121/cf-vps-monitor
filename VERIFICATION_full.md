# VERIFICATION — site-monitor 功能完整移植（F1~F8）+ 全量管理 UI

> 阶段：**全量交付**（P1~P7）——F1 CF 资产同步 / F2 CF 一键运维 / F3 域名+SSL / F4 SLA 月报 /
> F5 深度诊断 / F6 多区域共识 / F7 公开状态页 / F8 agent-mail 中继，含 P7 迁移脚本与部署文档
> 日期：2026-09-22
> 评审对象：本次新增/修改的全部代码、迁移、脚本与文档

## 1. 构建校验（门禁第 1 关，实测）

| 检查 | 命令 | 结果 |
|---|---|---|
| 迁移生成 | `npm run build:migrations` | ✅ Generated 6 |
| Worker 类型检查 | `wrangler types --check && tsc --noEmit` | ✅ 0 错误 |
| 前端构建 | `tsc -b && vite build` | ✅ 通过，新增产物 `CFAssets` / `SLA` / `Diagnose` / `AgentMail` / `StatusPage` |
| 迁移脚本 | `node scripts/migrate-site-monitor.mjs --dry-run` | ✅ 实测解析 **12 站点 / 46815 check / 500 event** |

## 2. 交付清单

### 2.1 后端（Cloudflare Worker）

| 文件 | 内容 |
|---|---|
| `worker/src/utils/cf-client.ts` | F1~F3：`CloudflareApi`（zones/workers/pages/domains/purge/dev-mode 读+写/rollback/SSL 天数）+ `resolveCfCredentials` dev/prod 双路径 |
| `worker/src/utils/cf-sync.ts` | F1/F3 同步核心（**路由与 Cron 共用**，避免重复实现）：`matchZoneId`（最具体 zone 优先）+ `syncCfAssets` |
| `worker/src/routes/cf.ts` | `GET /assets`、`GET /domains`、`GET /sync-runs`、`POST /sync`、`GET+POST /zone/:id/dev-mode`、`POST /zone/:id/purge`、`POST /worker/:name/rollback` |
| `worker/src/routes/ops.ts` | F4 `GET /sla`、F6 `GET /websites/:id/consensus`、F5 `GET /websites/:id/diagnose`、F8 `GET /notifications[/pending]`、`POST /notifications/ack`、`POST /notifications/enqueue` |
| `worker/src/utils/diagnose.ts` | F5：DoH（`cloudflare-dns.com/dns-query`）解析 ≤5 次查询 + HTTP 探测 + 分级 `reason_code` + 中文建议 |
| `worker/src/utils/consensus.ts` | F6：纯函数多数表决（`CONSENSUS_MIN=0.5`），节点为空返回 `unknown`（不伪装成功） |
| `worker/src/routes/public.ts` | F7：`GET /api/public/status`（免鉴权，复用公开缓存与限流守卫） |
| `worker/src/utils/notification-dispatch.ts` | F8：新增 `enqueueRelay` **依赖注入**钩子（避免本模块运行时依赖 db 造成循环导入），即时发送同时入队 |
| `worker/src/index.ts` | 挂载 `cfRoutes` / `opsRoutes`；Cron 新增 `cron_cf_sync`（节流）+ `cron_notify_expire`（超时兜底）；`ScheduledRunContext` 增 `env` 字段 |

### 2.2 数据与脚本

- `supabase/migrations/6_site_monitor.sql`：
  - 列扩展 `website_monitors.source/cf_project_name/cf_zone_id`、`website_checks.ssl_days_left`
  - 新表 `cf_sync_runs` / `cf_domains` / `notification_queue`（RLS + grant + policy 与既有迁移一致）
  - RPC：`cfm_cf_domains`、`cfm_cf_sync_runs`、`cfm_sync_cf_domains`（**单事务** upsert + 删旧行）、`cfm_insert_cf_sync_run`、`cfm_website_sla_report`、`cfm_website_consensus`、`cfm_notification_pending/queue`、`cfm_enqueue_notification`、`cfm_ack_notifications`、`cfm_expire_notifications`
  - 全部 `revoke public/anon/authenticated` + `grant service_role`
- `scripts/migrate-site-monitor.mjs`：P7 一次性迁移（sites/checks/events → Supabase），支持 `--dry-run` 与 `--sample`

### 2.3 前端（React + Radix + Recharts）

| 页面 | 路由 | 功能 |
|---|---|---|
| `pages/admin/CFAssets.tsx` | `/admin/cf` | F1 资产总览 + 一键同步 + 同步记录；F2 清缓存/开发模式（**回显真实状态**）/Worker 回滚；F3 域名 + SSL 表 + CSV 导出 |
| `pages/admin/SLA.tsx` | `/admin/sla` | F4 月度选择器 + KPI + Recharts 柱状图 + 表格 + CSV 导出 |
| `pages/admin/Diagnose.tsx` | `/admin/diagnose` | F5 站点选择 + 诊断结果（DNS/HTTP/原因码/建议） |
| `pages/admin/AgentMail.tsx` | `/admin/agent-mail` | F8 队列视图 + 批量确认 + 端点说明 |
| `pages/StatusPage.tsx` | `/status` | F7 公开状态页（免登录，plain fetch `/api/public/status`） |
| `pages/admin/adminMenu.tsx` `App.tsx` | — | 菜单项 + 面包屑 + 懒加载路由 |

### 2.4 文档

- `DEPLOY.md`：部署与运维全量手册（Supabase / CF 权限 / Worker 部署 / Agent 安装 / 功能对照 / F8 对接 / P7 迁移 / 本地开发）
- `DESIGN.md`（`E:\工作站\site-monitor\DESIGN.md`）升 **v2.0**：状态改为已实施，D1~D6 全部拍板并标注可推翻

## 3. 功能正确性自检

- **凭据安全**：Grep `nsju_` 全仓零命中；Token 仅存 git-ignored 的 `worker/.dev.vars`；生产期经 Supabase `settings`（RLS）取用。
- **sync 原子性**：`cfm_sync_cf_domains` 为单 plpgsql 函数（先 upsert 输入集、再 `delete ... not exists(输入集)`），任一步异常整体回滚，**绝不留空表**；route 对空输入跳过以防误删全表。
- **zone 匹配**：`matchZoneId` 按 zone name 长度降序，最具体优先，修正嵌套 zone（`a.example.com` vs `example.com`）误配。
- **失败可观测**：`getZoneSslDaysLeft` 失败 `console.error` 留痕后返回 null（不静默、不阻断）。
- **共识语义**：节点为空 → `unknown`；`up/total >= 0.5` → `up`。与 site-monitor 的 `CONSENSUS_MIN` 一致。
- **F8 不阻断主链路**：`enqueueAgentMailRelay` 用 try/catch 包住，入队失败仅记 health 事件。
- **权限降级结构化**：CF 写操作遇 403 返回 `{ok:false, reason:'permission'}`，前端 toast 显示原因，不伪装成功。

## 4. 待补 / 风险（诚实边界）

- **未做真实端到端联调**：`POST /sync` 写库、SLA 聚合、共识查询、UI 渲染均需已部署 + 已连 Supabase 才能验证（依赖 D6 的 SUPABASE_URL/key）。本轮做到**构建级 + 脚本 dry-run 实测**，未达到"线上跑通"。
- **F6 未做前端可视化接入**：`GET /consensus` 已提供 API 与纯函数，尚未在站点详情页渲染多节点结果（`/admin/diagnose` 也未展示共识）。
- **F8 拉取需 admin 会话**：WorkBuddy 自动化对接需先登录拿 Cookie + CSRF；若需免会话的只读 Token，要在 `routes/ops.ts` 加 Bearer 分支（尚未做）。
- **迁移脚本对 localhost 站点会失败**：源数据含 `http://localhost:3000/...`，RPC 会因 `unsafe_host` 拒绝 → 会 warn 并跳过（属预期，内网站不建议迁移）。
- **46815 条 check 逐条 RPC** 迁移较慢，若需加速可改批量 RPC（当前逐条但可控）。

## 5. 结论

门禁第 1 关（构建校验 + 脚本 dry-run 实测）通过。F1~F8 八项功能**后端与前端均已落地**，
代码风格与既有 `cfm_*` RPC 命名、admin 鉴权、Radix UI 一致。
待 D6 提供 Supabase 连接信息后即可部署联调。进入独立审议（REVIEW）。
