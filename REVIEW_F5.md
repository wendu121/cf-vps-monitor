<!-- reviewed-by: independent-subagent -->

# REVIEW_F5 — 独立审议（门禁 ③）

**结论：PASS**（无阻断问题；部署前置项见下方说明）

对照 `DESIGN_F5_ADDENDUM.md` 与 `VERIFICATION_F5.md`，逐项核查 P1–P5 源码与迁移 8。
构建/类型校验由 VERIFICATION 提供（worker/frontend tsc EXIT=0），本审议为静态代码审查。

---

## 逐问题评估

**P1 · 悬浮按钮遮挡（PASS）**
`AdminLayout.tsx:336-341` 给桌面端 `.admin-main-content` 增加 `padding-top:46px`；`.admin-top-actions` 仍 `absolute; top:0; right:0`，落在预留 46px 行内，页头从 46px 下开始。移动端 `@media(max-width:768px)` 同样 `46px`，两处一致。纯 CSS、零行为变更，遮挡消除。无逻辑风险。

**P2 · SLA 月报空数据（PASS）**
- 前端 `SLA.tsx` 已去除 `.catch(()=>null)`：`apiFetch` 在非 200 抛错（AuthContext.tsx:205-211），`load()` 捕获后置 `errorState` 并 `setRows([])`。
- 红卡渲染条件 `errorState ?`（L115）与空文案 `rows.length===0 && !errorState`（L180）互斥 → **错误永远不会被伪装成空数据**。22007 提示附带根因说明。
- 验证：502 不触发登出（`shouldClearAuthForStatus` 仅 401/403），错误 UX 干净。
- 后端 `ops.ts:42-44` 失败分支返回 `{month, rows:[], error}`（502），错误透传。
- 迁移 8 将 `cfm_website_sla_report` 的 `join agg` → `left join agg`，并原样保留迁移 7 的 `to_date`+月份守卫（bounds CTE 完全一致）。

**P3 · SSL 未知（PASS）**
- `cf-client.ts:279 getZoneSslInfo` 双路：主路 `/zones/{id}/ssl/certificate_packs` → 失败降级 `ctLogSsl(hostname)`（crt.sh，无凭据）。`ctLogSsl` 用 `encodeURIComponent(hostname)`，安全。两路皆空返回 `{days:null, source:null, error}`，不静默。
- `cf-sync.ts:82-87` 把 `ssl_source = info?.source ?? null` 一并落库；迁移 8 给 `cf_domains.ssl_source`（`CHECK in ('cf_api','ct_log')`），UI 可区分来源、不冒充官方。

**P4 · CF 资产一键导入（PASS）**
`admin.ts:2039-2161`：
- `dryRun = body.dryRun !== false` → 默认 true（L2044），仅预览不动库。
- 去重：`normalizeUrl`（trim/小写/去尾斜杠）比对 `existingUrls` 集合；preview 标记 `exists`（L2090-2104）。
- 创建循环：已存在 `skipped.push` 跳过（L2123）；`cand.cf_zone_id`（preview 字段，**非** `cand.zoneId`）正确传入（L2142）；`validateWebsiteMonitorInput` 校验后 `db.createWebsiteMonitor` 落库。
- 部分失败：`imported/skipped/errors` 三类分别收集；单条失败不中断整体（L2144-2151）。
- 审计：`website_import_cf` 明细（L2155）。
- 链路闭环：`validateWebsiteMonitorInput`（website-monitor.ts:254-256 透传 source/cf_zone_id/cf_project_name）→ `createWebsiteMonitor`（queries.ts:328 直传）→ `createSupabaseWebsiteMonitor`（client.ts:836 整对象透传 RPC）→ 迁移 8 `cfm_create_website_monitor` 已支持三列。类型安全。
- 前后端一致：前端 `importSelected` 存 hostname，发送 `urls: Array.from(importSelected)`；后端 `requested.includes(cand.hostname)` 匹配（Websites.tsx:680/704）。

**P5 · 延迟折线图（PASS）**
`WebsiteLatencyChart.tsx` 用 recharts 渲染近 N 次延迟折线；`checks` 为 `useState<WebsiteCheck[]>([])` 且 `loadChecks` 用 `Array.isArray` 兜底 → 永远为数组，不会因 `undefined` 崩溃（满足要求 #7）。`data.length===0` 时返回「暂无延迟数据」占位，**绝不伪造空图表**。已嵌入 Websites 编辑弹窗 `延迟趋势` 块，与 `WebsiteHeartbeatBar` 并列（Websites.tsx:984-994）。

---

## 阻断问题（Blocking）

无。

## 部署前置项（非阻断，但影响线上真实效果）

1. **迁移 7 + 8 必须部署到生产**（当前沙箱未部署）。未部署时：SLA 仍 502（left-join 未生效）；CF 导入 dryRun 可预览，但 `source/cf_*` 因 RPC 未升级而落不进库。
2. **`wrangler deploy` 未执行**：worker/frontend 改动需重新构建部署后线上面板方可生效。
3. **SSL 官方值**依赖 Token 是否授予 `SSL and Certificates:Read`；否则仅 CT log 估算（页面须明示来源）。

## 非阻断建议

- `getZoneSslInfo` 主路取到**负 days**（证书已过期）时仍返回 `source:'cf_api'`，UI 需能展示「已过期 X 天」，避免与「0 天」混淆（当前数据通路支持，仅 UI 文案建议）。
- `ops.ts` 多个 502 分支统一用 `errorDetail(e)`，建议确认 `errorDetail` 输出稳定包含 `22007`/SQLSTATE 以便前端精准提示（即便不含，红卡仍会渲染，不阻断）。
- 导入路由的 `error`/`detail` 经 `sanitizeSetupDiagnosticDetail` 处理，建议回归确认其不截断 CF 凭据（审查时未见凭据外泄，符合安全约定）。

---

## 安全核查（要求 #6）

- CF 凭据经 `resolveCfCredentials` 取自 env/settings，**未**写入代码或返回体；`creds` 对象不出现在任何响应/日志。
- 无字符串拼接 SQL：所有写入走 RPC 参数化（`jsonb`）。crt.sh 查询 `encodeURIComponent` 转义，无注入。
- `console.error` 仅记录 CF 错误消息与 zone id（非私密），且导入失败走 `sanitizeSetupDiagnosticDetail`。
- 无命令注入 / 代码中无密钥。
