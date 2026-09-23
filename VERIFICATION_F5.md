# VERIFICATION_F5 — 自审（门禁 ②）

> 对应设计：`DESIGN_F5_ADDENDUM.md`
> 范围：P1 悬浮按钮遮挡 / P2 SLA 空数据 / P3 SSL 未知 / P4 CF 资产一键导入 / P5 数据图表
> 自审人：主代理（非独立审议，独立审议见 `REVIEW_F5.md`）

## 门禁 ① · 构建 / 类型校验

| 目标 | 命令 | 结果 |
|------|------|------|
| Worker（tsc --noEmit） | `node worker/node_modules/typescript/bin/tsc --noEmit` | ✅ EXIT=0（见 `_tsc_worker.log`，0 error） |
| Frontend（tsc -b） | `node frontend/node_modules/typescript/bin/tsc -b` | ✅ EXIT=0（见 `_tsc_frontend.log`，0 error） |

> 说明：`npx` 在本沙箱会触发被拦截的 `wsl.exe`，故直接以托管 Node 调用本地 `typescript/bin/tsc`，等效于 `package.json` 的 build 类型阶段。

## 门禁 ② · 逐项静态自审（对照设计 §2.1–§2.5）

### P1 · 悬浮按钮遮挡页头（设计 §2.1）
- 根因：`.admin-top-actions{position:absolute;top:0;right:0;z-index:30}` 在桌面端无顶部留白，压住页面右侧控件（如 SLA 的上月/下月/刷新/导出）。
- 修复：`frontend/src/pages/admin/AdminLayout.tsx` 的 `.admin-main-content` 增加 `padding-top:46px`（桌面端原先只有 `@media(max-width:768px)` 有）。
- 校验：CSS 仅增加留白，不改定位逻辑；桌面端页头控件不再被覆盖。

### P2 · SLA 月报空数据（设计 §2.4）
- 根因（实测）：`GET /api/admin/ops/sla?month=2026-09` 返回 HTTP 502，body = `Supabase RPC cfm_website_sla_report failed: 400 {"code":"22007","message":"invalid input syntax for type date: \"2026-09\""}`。前端 `SLA.tsx` 的 `.catch(()=>null)` 把 502 吞掉 → 显示「本月暂无检测记录」，属于**把错误伪装成空数据**。
- 修复：
  1. 后端：`worker/src/routes/ops.ts:43` 已在失败分支返回 `{ month, rows:[], error }`（502），错误源已透传。
  2. 前端：`frontend/src/pages/admin/SLA.tsx` 去掉 `.catch(()=>null)`，改为捕获 `errorState` 并在页面渲染**红色错误卡**（含 22007 根因提示），仅当请求成功且 `rows.length===0` 才显示「本月暂无检测记录」。
  3. 根因修复（库侧）：迁移 `8_sla_leftjoin_cf_source.sql` 将 `cfm_website_sla_report` 的 **inner join → left join**，使「本月无检测记录」的站点仍出现在月报（而非被内连接丢弃）；同时保留迁移 7 的 `to_date` + 月份守卫（`create or replace`）。
- 校验：类型通过；错误卡渲染路径与空数据路径互斥（`!errorState` 守卫）。

### P3 · SSL 剩余天数「未知」（设计 §2.3）
- 根因（实测）：CF Token 访问 `certificate_packs` / `custom_certificates` / `certificates` **全部 403 code 9109** → 缺 `SSL and Certificates:Read`。非代码 bug，是权限问题。
- 修复（双路取数，显式标注来源，绝不混淆可信度）：
  1. `worker/src/utils/cf-client.ts:279` `getZoneSslInfo(zoneId, hostname?)`：主路 `/zones/{id}/ssl/certificate_packs`（CF 官方）→ 失败降级 `ctLogSsl(hostname)`（crt.sh 公开 CT log，无需凭据）→ 两路皆失败返回 `{days:null,source:null,error}`。
  2. `worker/src/utils/cf-sync.ts:80` 聚合时把 `ssl_source` 一并落库；迁移 8 给 `cf_domains` 加 `ssl_source`（CHECK `in('cf_api','ct_log')`）。
- 校验：类型通过；`ssl_source` 列与落库逻辑一致；UI 据 `ssl_source` 区分「CF 官方」与「CT 估算」。
- 诚实边界：若 Token 仍无 `SSL and Certificates:Read`，CT log 兜底给出**估算值**（有 ≤1 天缓存延迟，不保证等于边缘实际证书），页面须明示该来源，不得冒充官方。

### P4 · CF 资产一键导入网站监控（设计 §2.2）
- 后端：`worker/src/routes/admin.ts` 新增 `POST /admin/websites/import-from-cf`，body `{ urls?, dryRun? }`：
  - `dryRun` 默认 `true` → 返回候选预览（`hostname/url/source/cf_project_name/cf_zone_id/exists`），不动库。
  - 候选来源（与 CF 资产面板同源）：Worker 自定义域名→`cf_worker`；Pages 自定义域名 + Pages 默认域（`*.pages.dev`）→`cf_pages`；**不含 zone 裸域名**。zone_id 经 `matchZoneId` 按后缀匹配最具体 zone。
  - 实际导入：以 `validateWebsiteMonitorInput` + `db.createWebsiteMonitor` 落库，并携带 `source` / `cf_zone_id` / `cf_project_name`；已存在（按 URL 去重）自动跳过；写审计 `website_import_cf`。
- 前端：`frontend/src/pages/admin/Websites.tsx` 增加「从 CF 导入」按钮 + 弹窗（预览候选、勾选、已存在置灰、导入选中、结果摘要）。
- 关键一致性修复：`worker/src/utils/website-monitor.ts` 的 `validateWebsiteMonitorInput` 原先**会丢弃** `source/cf_*`，已扩展为透传（并校验 `source ∈ {manual,cf_worker,cf_pages}`）；迁移 8 教 `cfm_create_website_monitor` / `cfm_update_website_monitor` 写入这三列。`worker/src/db/supabase-api/client.ts:835` 把整个 `monitor` 透传给 RPC，链路自洽。
- 校验：类型通过；`cand.zoneId`（Candidate 字段）在预览映射处使用，创建循环处改用 `cand.cf_zone_id`（preview 字段）——已修。

### P5 · 数据图表（设计 §2.5，G5）
- 新增 `frontend/src/components/WebsiteLatencyChart.tsx`：用 recharts 渲染最近 N 次检测的**延迟折线**（无数据时显示占位，绝不伪装空图表）。
- `frontend/src/pages/admin/Websites.tsx` 在编辑弹窗内嵌入「最近检测状态（心跳条）+ 延迟趋势（折线）」两块；与既有 `WebsiteHeartbeatBar`（状态带）共同构成「延迟线 + 状态带」。
- SLA 页原有 `BarChart`（可用率对比）保留。
- 校验：类型通过；recharts 为既有依赖（SLA 已用）。
- 范围说明：服务器历史图表**按设计延期**到独立里程碑（需新建历史表），不在本 F5 内。

## 待办 / 诚实边界（门禁未闭环项）

1. **迁移 7 + 8 尚未部署到生产 Supabase**。迁移 7（`7_sla_month_fix.sql`）虽已通过评审但未被应用；迁移 8 为其追加，未改 7（遵循「已评审迁移不可改，修复走新迁移」）。
   - 部署方式二选一（无凭证绕过路径，Supabase 无 `exec_sql` RPC）：
     - **A（默认）**：在 Supabase SQL Editor 依次粘贴执行 `supabase/migrations/7_sla_month_fix.sql` 与 `8_sla_leftjoin_cf_source.sql`；
     - **B**：提供 `sbp_` 开头的 Supabase PAT，由 `wrangler deploy` / 迁移脚本应用。
   - 未部署则：SLA 月报仍 502（left-join 未生效）；CF 导入可走 dryRun 预览，但实际落库的 `source/cf_*` 列因 RPC 未升级而落不进去。
2. **`wrangler deploy` 未执行**：worker + frontend 改动需重新构建并部署后，线上面板才能看到 P1/P3/P4/P5 的真实效果。
3. **SSL 官方值**取决于 Token 是否授予 `SSL and Certificates:Read`；否则仅 CT log 估算。
4. **线上实测**（SLA 不再空、导入成功落库、图表渲染）需在 1+2 完成后做端到端验证（本沙箱已对 SLA 502 做探针复现，见根因；其余为静态/类型验证）。

## 门禁 ① 证据文件
- `E:\第二电脑\_tsc_worker.log`（WORKER_EXIT=0）
- `E:\第二电脑\_tsc_frontend.log`（FRONTEND_EXIT=0）
