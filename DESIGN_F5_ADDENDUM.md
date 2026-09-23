# DESIGN 增量 F5 —— 后台面板可用性修复与新功能

> 日期：2026-09-23 · 状态：**待实现** · 上游：`DESIGN.md` v2.x（F1/F2/F3 已完成）
> 触发：boss 实测反馈「UI 没有数据图表 / SLA 月报空数据 / 切换页面被挡住 / 要实现（CF 导入 + SSL）」

---

## 0. 问题清单（全部附实测证据，非推断）

| # | 现象 | 根因（实测） | 证据来源 |
|---|---|---|---|
| **P1** | 后台每页标题栏右侧按钮被 4 个悬浮按钮遮挡 | `AdminLayout.tsx` 的 `.admin-top-actions` 桌面端 `position:absolute; top:0; right:0; z-index:30`，但 `.admin-main-content` **桌面端未留顶部空间**（只有 `@media (max-width:768px)` 里补了 `padding-top:46px`）。任何页面的页头右端控件（如 SLA 页「上月/下月/刷新/导出」）都被压在下面 | 源码 `AdminLayout.tsx` L339–352、L403–405；boss 截图 |
| **P2** | SLA 月报全空 | 线上 `GET /api/admin/ops/sla?month=2026-09` → **HTTP 502**，body：`Supabase RPC cfm_website_sla_report failed: 400 {"code":"22007","message":"invalid input syntax for type date: \"2026-09\""}`。前端 `SLA.tsx:L48` 用 `.catch(() => null)` **把 502 吞成空数组**，配合 `rows.length > 0` 才渲染图表 → 表现为「本月暂无记录」+ 无图 | 探针 `_probe_live.mjs` 线上实测 |
| **P3** | 「域名与 SSL」剩余天数恒「未知」 | `cf-client.ts:getZoneSslDaysLeft()`（L258）调 `/zones/{id}/certificates?limit=100`，而该 Token 读**任何**证书接口都返回 **403 code 9109**（12/12 zone 一致）：`certificate_packs`、`custom_certificates`、`certificates` 全拒。函数 catch 后 `return null` → `ssl_days_left` 恒 null | 探针 `_cf_cert_probe.mjs` 实测 |
| **P4** | 无「从 CF 资产导入网站监控」 | 后端只有 `POST /admin/websites/add`（单条，`admin.ts:L2003`）；前端只有「导入备份」。但 `website_monitors` 表**已有** `source`(default `manual`) / `cf_zone_id` / `cf_project_name`（`6_site_monitor.sql` L8–10）→ 属**设计内缺口**，非新概念 | 源码 + migration 6 |
| **P5** | 面板缺数据图表 | 服务器页（`Dashboard.tsx`）只有数字卡，零图表；SLA 页**本有** `BarChart`（`SLA.tsx:L136`）但被 P2 遮死；网站页有 `WebsiteHeartbeatBar` 心跳条 | 源码 |

> **排除项**：CF 资产同步（F1）**没有缺失** —— 已实测 `zones=12 / workers=8 / pages=4` 与 CF API 直查逐项一致。

---

## 1. 目标

- **G1** 消除 P1 遮挡（纯样式，零行为变更）
- **G2** 实现「CF 资产 → 网站监控」一键导入（P4），复用表内既有 CF 归属字段
- **G3** SSL 剩余天数取到真数据（P3），无权限时不伪装成「未知」
- **G4** SLA 页失败**不伪装成空**（P2 前端侧）；并给出生产闭环路径（P2 后端侧）
- **G5** 补齐可用图表（P5），范围见 §2.5

---

## 2. 详细设计

### 2.1 G1 · 遮挡修复（`frontend/src/pages/admin/AdminLayout.tsx`）

**方案**：桌面端给内容区留出悬浮按钮的专属行，与移动端既有策略对齐。

```css
.admin-main-content { position: relative; padding-top: 46px; }   /* 桌面端新增 */
/* 覆盖移动端重复声明，保持 46px 一致 */
```
- 悬浮按钮继续 `absolute; top:0; right:0`，此时落在预留的 46px 空白行内；
- 页面自身页头从 46px 之下开始，**不再重叠**；
- 不改任何交互与 DOM 结构，回归面最小。

**否决方案**：
- 改成 `position: sticky` 入流 → 按钮横跨整行、视觉改动大，且每个页面都要重排；
- 降低 `z-index` → 只是把遮挡关系反过来，按钮反而被内容压住，不可用。

### 2.2 G2 · CF 资产一键导入

**后端**（新增路由，`worker/src/routes/admin.ts`）：

```
POST /api/admin/websites/import-from-cf
body: { urls?: string[]; dryRun?: boolean }   // 省略 urls = 预览全部候选
resp: { ok, dryRun, created, skipped, candidates: [{ url, name, source, cf_zone_id?, cf_project_name?, exists }] }
```

要点：
1. **候选来源**（与 CF 资产面板同源，避免二次定义）：
   - Worker 自定义域名（`customDomains.workers[*].hostname`）→ `source='cf_worker'`
   - Pages 自定义域名（`customDomains.pages[*]`）→ `source='cf_pages'`
   - Pages 默认域名（`pages[*].subdomain`）→ `source='cf_pages'`
   - **不含** zone 裸域名（既有认知：裸域名常无 DNS 记录，会误报离线，见 `cf-client.ts` L203 注释）
2. **规范化去重**：`new URL(u)` 后比对 `origin + pathname`（忽略尾斜杠/大小写主机名），与现有 monitors 全量比对 → `exists` 标记
3. **`dryRun` 默认 true**：前端先预览，用户勾选后带 `urls` 复调落库；避免"一键导入"变成不可撤销的批量写入
4. 落库复用 `db.createWebsiteMonitor` + `validateWebsiteMonitorInput`，**不绕过校验**；`source` 取 CF 来源，`cf_zone_id`/`cf_project_name` 一并落库
5. 审计日志 `website_import_cf`（记录 created/skipped 明细）

**前端**（`Websites.tsx`）：页头加「从 CF 导入」按钮 → 弹窗：
- 拉 `GET /admin/cf/assets` + `POST .../import-from-cf {dryRun:true}` 合并展示候选；
- 每行：勾选框 + URL + 来源标签 + `已存在` 灰显（不可勾）；
- 全选/反选 + 「导入 N 项」；成功后 toast + 刷新列表 + 广播 `notifyWebsiteMonitorsUpdated`。

### 2.3 G3 · SSL 剩余天数

**根因是权限**（P3），不是算法。两条路径，**默认走 A，A 不可用时自动降级 B**：

- **A（正规）**：改用 `/zones/{id}/ssl/certificate_packs?per_page=50`，取所有 pack 内 `certificates[].expires_on` 最早者。需 boss 给 Token 加 `Zone → SSL and Certificates → Read`。
- **B（零权限兜底）**：走公开 CT log（`https://crt.sh/?q=<host>&output=json`），取最新证书 `not_after`。无认证、免费；缺点是有缓存延迟（最长约 1 天），且为第三方依赖。

**实现约定**：
- `getZoneSslDaysLeft()` 返回 `{ days: number|null, source: 'cf_api'|'ct_log'|null, error?: string }`，**不再静默 null**；
- `cf-sync.ts` 落库 `ssl_days_left` 同时落 `ssl_source`（新增列，migration 8）→ UI 可标注数据来源；
- 权限/网络失败时 UI 显示「未知（原因：Token 缺 SSL:Read）」，而不是空白「未知」。

> ⚠️ **决策点 D1**：走 A（需 boss 加 CF Token 权限，最准）还是 A+B（我实现双路，加权限前也有数据）？**默认实现 A+B**。

### 2.4 G4 · SLA 页（`SLA.tsx`）

- **前端（本轮做）**：把 `apiFetch(...).catch(() => null)` 改为捕获真实错误：
  - 失败时保留 `rows=[]` **但置 `error` 状态**，页头显示红色告警卡：`SLA 数据加载失败：<后端 error>` + 根因提示（`22007` → 「数据库函数月份解析错误，需应用迁移 7」）；
  - 图表区在 `error` 时显示占位说明，而非静默消失；
  - 不再出现「本月暂无检测记录」这种**把故障说成没数据**的误导文案（仅真正无记录时才显示）。
- **后端（需 boss 出手）**：`supabase/migrations/7_sla_month_fix.sql` 应用到生产。两条路：
  1. boss 在 Supabase SQL Editor 粘贴执行（零凭据，最简）；
  2. boss 提供 `sbp_` PAT → 我 `wrangler deploy`（打包已含迁移 7 清单）+ 调 Worker 内置迁移执行器。
  - 已核实：全仓无 `exec_sql` RPC，service key 无法跑 DDL，**没有无凭据旁路**。

### 2.5 G5 · 图表

| 页面 | 现状 | 本轮动作 |
|---|---|---|
| SLA 月报 | 有柱状图，被 P2 遮死 | 修好 P2 即自然可见；另加 `error` 态占位 |
| 网站 | 有心跳条 | **新增**：选中某监控项时展示「近 60 次检测」延迟折线 + 状态色带（数据源既有 `GET /admin/websites/{id}/checks?limit=60`，**零新接口**） |
| 延迟监测 | 无图 | 复用既有 `MiniPingChart`，为每个 ping 任务渲染最近延迟迷你折线 |
| 服务器 | 仅数字卡 | **暂不做**：需要"历史指标序列"存储（当前 liveData 仅实时快照、无历史）→ 属独立里程碑，避免过度工程 |

> ⚠️ **决策点 D2**：服务器页历史趋势图需新增指标历史表（定时落库 + 保留策略 + 体积控制），**建议单独立项**，本轮不做。如 boss 坚持要，需先出该子设计。

---

## 3. 影响面与兼容性

- **新增 DB 列**：`ssl_source`（migration 8，`add column if not exists`，幂等）。**同 7 一样需部署到生产**。
- **新增路由**：1 个（`POST /admin/websites/import-from-cf`），只增不改；
- **改动路由**：无（`websites/add|edit|delete|reorder` 全不动）；
- **前端**：`AdminLayout.tsx`(CSS) / `SLA.tsx` / `Websites.tsx` / `PingTasks.tsx`；
- **回滚**：全部为增量（新列可空、新路由独立、CSS 单条声明），回滚只需 revert 提交。

## 4. 验收标准（真实数据，不接受 mock）

1. `/admin/sla` 在迁移 7 应用后返回 200 且 `rows.length === 12`，柱状图可见；
2. 迁移 7 **未**应用时，页面显示明确错误（含 `22007` 提示），**不显示**「暂无检测记录」；
3. `/admin/websites` 点「从 CF 导入」→ 预览出候选（≥12），导入后列表出现新项且 `source` 为 `cf_*`；
4. 重复导入同一批 → `created=0, skipped=n`（幂等）；
5. 任一页面标题栏右端按钮**不再**被悬浮按钮遮挡（浏览器实测截图）；
6. SSL 列显示真实剩余天数 或 「未知（原因：…）」。

## 5. 待 boss 决策

- **D1** SSL 路径：A（仅加权限）/ **A+B（默认）**；
- **D2** 服务器页历史趋势图：本轮不做（默认）/ 单独立项；
- **D3** 迁移 7 + 8 上线方式：SQL Editor 粘贴（默认，零凭据）/ 给 `sbp_` PAT 走 wrangler。
