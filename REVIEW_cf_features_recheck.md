<!-- reviewed-by: independent-subagent -->

# 独立复核报告 — cf-vps-monitor（针对 REVIEW_cf_features.md 的 4 项 WARN + 1 项 UX 限制修复）

> 复核方式：独立读取 8 个当前源文件 + grep 残留函数 / Token / git-ignore 验证。未修改任何源文件。
> 对照：上轮 `REVIEW_cf_features.md` 的 ③#1~#4 与 ④「UX dev-mode 回显」建议。

## ① 总体结论

**PASS（修复正确且无误）。**

- ③#1 非原子同步：已落地为单事务 RPC `cfm_sync_cf_domains`，迁移/适配器/queries/route 四层一致替换，旧 `clear+upsert` 函数已无残留，route 对空输入跳过。✅
- ③#2 嵌套 zone 误配：已按 name 长度降序匹配。✅
- ③#3 SSL 吞错：catch 已补 `console.error` 并保留 null 降级。✅
- ③#4 面包屑：`getAdminSectionTitle` 已补 `/admin/cf` 分支。✅
- UX dev-mode 回显：后端 `GET /zone/:id/dev-mode` + `cf-client.getDevMode` + 前端并行 useEffect 回显 Switch，均已落地。✅
- 安全复检：`nsju_` 全源码零命中；`.dev.vars` 仍被 git 忽略。无新阻塞项。

---

## ② 逐项复核结果

### ③#1 非原子同步修复 —— PASS
| 检查点 | 结论 | 证据 |
|---|---|---|
| 单 plpgsql 函数，先 upsert 再 delete not exists(输入集) | PASS | `6_site_monitor.sql:127-155` `create or replace function public.cfm_sync_cf_domains(input_rows jsonb) returns void language plpgsql`：`:133-146` `insert ... on conflict ... do update` 先 upsert 输入集；`:148-153` `delete from cf_domains where not exists (select 1 from jsonb_array_elements(input_rows) ...)` 删除不在输入集的旧行。整段在 `begin...end;` 内，plpgsql 默认事务原子执行，任一步异常整体回滚，绝不留空表。 |
| grant 为 service_role | PASS | `6_site_monitor.sql:187-190` revoke(public/anon/authenticated) + `grant execute ... to service_role`，签名 `(jsonb)` 正确。 |
| route 对空输入跳过（防误删全表） | PASS | `cf.ts:127` `if (domainRows.length > 0) await db.syncCfDomains(database, domainRows);` 空输入不调用 RPC，避免误清空。 |
| 旧 RPC 已不存在（grep 确认） | PASS | grep `cfm_clear_cf_domains\|cfm_upsert_cf_domains` 全仓仅命中 `REVIEW_cf_features.md` / `VERIFICATION_cf_features.md` 两篇旧文档，**源码零命中**。 |
| client.ts 无残留未用函数 | PASS | `client.ts:883-885` 仅保留 `syncSupabaseCfDomains`（调用 `cfm_sync_cf_domains`）；`getSupabaseCfDomains` / `getSupabaseCfSyncRuns` / `insertSupabaseCfSyncRun` 仍存在且被 queries 使用。无 `clearSupabaseCfDomains` / `upsertSupabaseCfDomains`。 |
| queries.ts 无残留未用函数/导入 | PASS | `queries.ts:391-393` 仅 `syncCfDomains` 包装 `sba.syncSupabaseCfDomains`；`listCfDomains`/`listCfSyncRuns`/`insertCfSyncRun` 均被 route 使用。无 `clearCfDomains`/`upsertCfDomains`。 |
| on conflict 键一致 | PASS | `6_site_monitor.sql:142` `on conflict (project_name, domain)` 与 `cf_domains` 唯一约束 `unique (project_name, domain)`（`:45`）一致。 |

### ③#2 matchZoneId 嵌套 zone 误配 —— PASS
| 检查点 | 结论 | 证据 |
|---|---|---|
| 按 name 长度降序匹配最具体 zone | PASS | `cf.ts:36` `const sorted = [...zones].sort((a, b) => b.name.length - a.name.length);` 后 `:37-40` 遍历匹配；`sub.a.example.com` 场景 `a.example.com` 优先于 `example.com` 返回正确 zone_id。注释 `:34-35` 明确说明意图。 |

### ③#3 SSL 静默吞错 —— PASS
| 检查点 | 结论 | 证据 |
|---|---|---|
| catch 含日志、仍 return null | PASS | `cf-client.ts:273-275` `catch (e) { console.error(\`[cf-client] getZoneSslDaysLeft failed for zone ${zoneId}:\`, ...); return null; }` 已补服务端日志，降级语义（UI 显示「未知」）保留。 |

### ③#4 面包屑缺失 —— PASS
| 检查点 | 结论 | 证据 |
|---|---|---|
| `getAdminSectionTitle` 含 `/admin/cf` 分支 | PASS | `adminMenu.tsx:137` `if (pathname.startsWith('/admin/cf')) return 'CF 资产';` 位于默认回退 `return '管理后台'`（`:142`）之前，命中正确。 |

### UX dev-mode 回显 —— PASS
| 检查点 | 结论 | 证据 |
|---|---|---|
| 后端 `GET /zone/:zoneId/dev-mode` 返回 `{ok, enabled}` | PASS | `cf.ts:178-189` 新增 GET 路由：`const res = await api.getDevMode(zoneId);` 失败返回结构化错误（403 权限 / 502），成功 `return c.json({ ok: true, enabled: res.enabled })`。 |
| cf-client 新增 `getDevMode` | PASS | `cf-client.ts:310-321` `async getDevMode(zoneId): Promise<{ok:true; enabled:boolean} | {ok:false; ...}>` 读取 `/zones/${zoneId}/settings/development_mode`，`enabled = (result.value||'off')==='on'`。 |
| 前端加载后并行 fetch 各 zone dev-mode 并 setDevModeLocal | PASS | `CFAssets.tsx:86-105` 新增 `useEffect`，依赖 `[assets, apiFetch]`；`Promise.all(zones.map(... /admin/cf/zone/${z.id}/dev-mode ...))` 并行拉取；`:101-102` 合并进 `devModeLocal`（`prev => ({...prev, ...next})`）。Switch 状态 `:305` `checked={devModeLocal[z.id] ?? false}` 现已正确回显，消除「恒为 off」误导。 |

### 安全复检 —— PASS
| 检查点 | 结论 | 证据 |
|---|---|---|
| `nsju_` 全仓零命中（Token 未进代码） | PASS | grep `nsju_` 全仓仅命中 `REVIEW_cf_features.md:31` 与 `VERIFICATION_cf_features.md:62`（历史说明文档）；**源码零命中**。`CF_API_TOKEN`/`CF_ACCOUNT_ID` 仍仅作变量名（env 读取 / 文案）。 |
| `.dev.vars` 仍被 git 忽略 | PASS | `git check-ignore worker/.dev.vars` 返回 `worker/.dev.vars`，确认忽略生效。 |

### 无回归（未用导入 / 变量） —— PASS
| 检查点 | 结论 | 证据 |
|---|---|---|
| client.ts 导入/导出 | PASS | `client.ts:3` `import type { CfDomain, CfDomainInput, CfSyncRun, CfSyncRunInput }` 全部被 `:874-889` 使用；无残留 clear/upsert 导出。 |
| queries.ts 导入/导出 | PASS | `queries.ts:1` `export * from './types'`（含 `CfDomainInput`）；`cf.ts:104` 使用 `db.CfDomainInput[]` 经 re-export 解析，类型闭合；CF 区块 `:382-397` 无未用项。 |
| cf.ts 导入 | PASS | `cf.ts:10-16` `Hono/Context/Bindings/Variables/db/CloudflareApi/resolveCfCredentials/getDatabase/errorDetail` 全部使用（route 与 `requireCredentials`/`matchZoneId`/sync 路径）。 |
| CFAssets.tsx 导入与类型 | PASS | `:1` `useCallback, useEffect, useMemo, useState` 均使用；`:2-13` 组件导入中 `Switch`/`Tooltip` 用于 dev-mode 行（`:304-305`），`Badge`/`Box`/`Button`/`Card`/`Flex`/`Grid`/`Table`/`Text` 均使用；`useEffect` 内 `zones.map(async (z: { id: string }) => ...)` 类型正确，无隐式 any 泄漏。 |

---

## ③ 是否发现新阻塞项

**未发现新阻塞项（FAIL=0）。**

非阻塞观察（不构成回归，供参考）：
1. `cf.ts:127` 空输入跳过同步：若 CF 配置正常但确实返回零自定义域名，旧 `cf_domains` 行不会被清空（保留上次数据）。这是「防误删全表」安全取向的取舍——空结果可能源于瞬时 API 失败而非真无域名。符合 ③#1 修复要求，不记为缺陷；若希望「真无域名即清空」，可后续在 route 层增加「区分空结果与拉取失败」的判定，但当前按需求 PASS。
2. dev-mode 回显 useEffect 依赖 `[assets, apiFetch]`：`loadAll` 重跑（如同步后）会刷新 `assets` 引用并重新拉取 dev-mode 状态，与本地 `setDevModeLocal` 合并（spread），不会丢失用户已切换值；无竞态风险。

---

## ④ 与上轮对照小结

| 上轮项 | 上轮结论 | 本轮复核 |
|---|---|---|
| ③#1 非原子同步 | WARN（较重要） | 已修复 → PASS |
| ③#2 嵌套 zone 误配 | WARN | 已修复 → PASS |
| ③#3 SSL 静默吞错 | WARN | 已修复 → PASS |
| ③#4 面包屑缺失 | WARN（轻微） | 已修复 → PASS |
| UX dev-mode 不回显 | WARN（已知限制） | 已修复 → PASS |

所有上轮 WARN 与已知限制均已正确落地，且未引入编译/安全/残留未用代码回归。**复核结论：PASS。**
