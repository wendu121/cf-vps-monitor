<!-- reviewed-by: independent-subagent -->

# 独立审议报告 — cf-vps-monitor site-monitor 功能移植（F1/F2/F3）

> 审议对象：`E:\工作站\cf-vps-monitor-src` 本次新增的 CF 资产同步(F1)、一键运维(F2)、域名+SSL(F3) 相关代码与迁移。
> 审议方式：独立读取 10 个指定文件 + 关键 Grep/对照，未修改任何源文件。
> 对照文档：`VERIFICATION_cf_features.md`（作者自审）。

## ① 总体结论

**带 WARN 通过（PASS with WARN）。**

- 编译、安全、SQL RPC 正确性、前端路径与既有代码一致性均达到通过标准；未发现硬编码凭据、未用导入、await 遗漏或 RPC 授权越权。
- 存在 3 项业务逻辑 WARN（其中「clear+upsert 非原子」较重要）与 2 项轻微前端/运维 WARN，均非编译或安全阻塞，但建议在部署联调前修复或记录。
- 阻塞项清单见 ③，均无「必须立即阻断发布」级 FAIL；但 #1（非原子同步）在数据可靠性上建议优先处理。

---

## ② 逐项审查结果

### A. 类型与编译
| 项 | 结论 | 证据 |
|---|---|---|
| 未用导入 / 变量 | PASS | `cf.ts:10-19` 导入 `Hono/Context/Bindings/Variables/db/CloudflareApi/resolveCfCredentials/getDatabase/errorDetail` 全部使用；`cf-client.ts` 导出接口均被使用；`CFAssets.tsx:1-17` 导入均使用；`types.ts:407-454`、`queries.ts:380-400`、`client.ts:872-892` 追加内容均被引用。作者自审已声明 `tsc --noEmit` 0 错误。 |
| `requireCredentials` 改 async 后调用点均 await | PASS | 定义 `cf.ts:21`（`async function`）；5 处调用 `cf.ts:44 / 86 / 138 / 154 / 177` 均为 `const creds = await requireCredentials(c);`。无遗漏同步调用。 |
| RPC `jsonb` → TS 反序列化错位（`ssl_days_left` 可能为 null） | PASS | `CfDomain.ssl_days_left: number \| null`（`types.ts:416`），`synced_at: string`（`types.ts:417`）；`cfm_cf_domains` 返回 jsonb 数组经 `callSupabaseRpc<CfDomain[]>` 直接 `response.json()`（`client.ts:60-78, 874-876`），与既有 `cfm_website_monitors` 同模式，无 `{"result":...}` 包装层错位风险。null 路径已正确建模。 |

### B. 安全
| 项 | 结论 | 证据 |
|---|---|---|
| CF Token 未硬编码 | PASS | Grep `nsju_` 全仓（含 src/frontend，排除 node_modules 与 dist）**零命中**；`CF_API_TOKEN`/`CF_ACCOUNT_ID` 仅作变量名出现于 `cf-client.ts:64-65`（env 读取）、`CFAssets.tsx:172`（帮助文案）、`worker-configuration.d.ts`（生成类型），均非明文令牌。真实凭据在 `worker/.dev.vars`，`.gitignore:16` 为 `.dev.vars*`（已忽略）。 |
| `resolveCfCredentials` dev/prod 双路径 | PASS | dev 走 env：`cf-client.ts:77` `e.CF_API_TOKEN`；prod 走 settings：`cf-client.ts:78` `settings?.cf_api_token`；`cf.ts:24` 经 `getSettingsByKeys(database, ['cf_api_token','cf_account_id'])` 取生产期凭据。两条路径均覆盖，且 `resolveCfCredentials` 任一有值即返回。 |
| RPC 授权（非 public/anon） | PASS | 5 个 RPC 均 `revoke all ... from public / anon / authenticated` + `grant execute ... to service_role`（`6_site_monitor.sql:176-199`）；后端以 `SUPABASE_SECRET_KEY`（service_role，`client.ts:34-36`）调用。前端从不直连 Supabase，且 `/api/admin/*` 经 JWT+CSRF 中间件（`index.ts:328-393`）。 |

### C. SQL RPC 正确性
| 项 | 结论 | 证据 |
|---|---|---|
| `create or replace` 语法 | PASS | `6_site_monitor.sql:99,112,125,133,156` 语法正确，含 `set search_path = public`。 |
| `on conflict` 键 | PASS | `cfm_upsert_cf_domains` 冲突键 `(project_name, domain)`（`6_site_monitor.sql:148`）与 `cf_domains` 的 `unique (project_name, domain)`（`:45`）一致。 |
| `jsonb_array_elements` 用法 | PASS | `:147` `from jsonb_array_elements(input_rows) as t(x)`，在 plpgsql 块内正确展开并逐行 upsert。 |
| grant 语句完整 | PASS | 5 个 RPC 各含完整 revoke(public/anon/authenticated)+grant(service_role)；两个带参 RPC 使用签名 `(jsonb)`（`:191-194, 196-199`），零参 RPC 省略签名，均合法。 |
| upsert 列 ↔ `cf_domains` 结构一致 | PASS | upsert 列 `(project_name, project_type, domain, zone_id, ssl_days_left, synced_at)`（`:139-146`）全部对应 `cf_domains` 实列（`:39-46`），未写 `id`（自增）；`project_type` 有 `in ('worker','pages')` 兜底（`:142`）。 |

### D. 业务逻辑
| 项 | 结论 | 证据 |
|---|---|---|
| `matchZoneId` 后缀误匹配 | **WARN** | `cf.ts:32-40` 按 `zones` 数组顺序返回首个匹配。若 `sub.a.example.com` 同时匹配 zone `a.example.com` 与 `example.com`，且 `example.com` 在数组靠前，会返回**更不精确**的 zone_id → SSL 天数错配。建议：匹配前按 `z.name.length` 降序排序，优先最具体 zone。 |
| `getZoneSslDaysLeft` 静默吃错 | **WARN** | `cf-client.ts:272-274` `catch { return null; }` 完全吞掉异常，不记日志。失败时 UI 显示「未知」但服务端无任何痕迹，排障困难。属设计性降级（作者自审 §3 已说明），建议至少 `console.error` 或累加失败计数。 |
| sync `clear + upsert` 非原子 | **WARN（较重要）** | `cf.ts:124-125` 先 `clearCfDomains` 再 `upsertCfDomains`，为两次独立 RPC/HTTP 调用，无事务。若 clear 成功、upsert 中途失败（网络/权限/约束），表被清空且 `catch`（`:130-132`）仅写 sync_runs 日志 → 用户看到**空域名表**。建议合并为单事务 RPC `cfm_sync_cf_domains(input_rows jsonb)`（内部：upsert 输入集 + 删除不在输入集的旧行），或在失败路径不预先 clear。 |

### E. 前端
| 项 | 结论 | 证据 |
|---|---|---|
| `useApi` 路径 `/admin/cf/...` 正确 | PASS | `withApiBase`（`api.ts:11-17`）：`/admin/cf/assets` → `/api/admin/cf/assets`，与后端挂载点 `index.ts:396`（`app.route('/api/admin/cf', cfRoutes)`）一致；POST 自动带 `X-CSRF-Token`（`api.ts:40-43`）。 |
| `devModeLocal` 初始状态未知（不读 CF 当前值） | **WARN（已知限制）** | `CFAssets.tsx:63` 初值 `{}`，`:283` `checked={devModeLocal[z.id] ?? false}` 恒为 off，不回显 CF 实际 dev-mode。若 CF 实际为 on，UI 显示 off，用户点「开」会发 `on=true`（无实际变化）却 toast 成功——可能误导。作者自审 §4 已承认，建议后续加读取接口回显。 |
| CSV 导出 | PASS | `CFAssets.tsx:141-152` 含表头、null 转空串、字段引号转义（`""`）、UTF-8 BOM，逻辑合理。 |
| 权限错误 toast | PASS | 后端 403 返回 `{ ok:false, error }`（`cf.ts:146,169,185`），`useApi` 抛出 `data.error`（`AuthContext.tsx:210`），toast 显示原因；`reason:'permission'` 已结构化。 |
| 懒加载路由 & 菜单 active 高亮 | PASS（轻微 WARN） | `App.tsx:35,140` 懒加载 `/admin/cf` → `AdminCFAssets`；`adminMenu.tsx:32` 菜单项 + `isAdminMenuPathActive` 默认分支 `currentPath === itemPath`（`adminMenu.tsx:68`）对 `/admin/cf` 正确高亮。**但** `getAdminSectionTitle`（`adminMenu.tsx:111-142`）无 `/admin/cf` 分支 → 回退默认「管理后台」。建议补 `if (pathname.startsWith('/admin/cf')) return 'CF 资产';`（轻微 WARN）。 |

### F. 与既有代码一致性
| 项 | 结论 | 证据 |
|---|---|---|
| RPC 命名 `cfm_*` 与 `4_rpc_api.sql` 一致 | PASS | `6_site_monitor.sql:99-199` 五个 `public.cfm_*` 与 `4_rpc_api.sql` 既有 `cfm_*` 命名/风格一致（均 `public.cfm_<entity>`）。 |
| 适配器/包装函数同层模式一致 | PASS | `client.ts:874-892`（`getSupabaseCfDomains` 等）与 `queries.ts:382-400`（`listCfDomains` 等）与既有 `getSupabaseWebsiteMonitors`/`listWebsiteMonitors` 同层，均 `callSupabaseRpc<T>(env, 'cfm_...', {...})`，模式统一。 |

---

## ③ 必须修复的阻塞项清单

> 本轮未发现「安全/编译级」阻塞（无 FAIL）。以下为建议修复项，按优先级排列；部署联调前至少处理 #1。

1. **【较重要·数据可靠性】sync 非原子清空风险** — `cf.ts:124-125`。clear 与 upsert 跨两次 RPC，失败会留空表。建议改为单事务 RPC 或在失败路径不预先 clear。
2. **【正确性】`matchZoneId` 多嵌套 zone 误匹配** — `cf.ts:32-40`。按 zone name 长度降序匹配最具体 zone，避免 `example.com` 抢先于 `a.example.com`。
3. **【可观测性】`getZoneSslDaysLeft` 静默吞错** — `cf-client.ts:272-274`。失败时至少 `console.error`，便于排障（当前 SSL「未知」无服务端痕迹）。
4. **【一致性】`getAdminSectionTitle` 缺 `/admin/cf` 分支** — `adminMenu.tsx:111-142`。补返回「CF 资产」，避免面包屑显示「管理后台」。

以上 4 项均不阻断构建，但 #1/#2 影响数据正确性，建议进入联调前修复。

---

## ④ 可选改进建议

- **dev-mode 回显**：`CFAssets.tsx:283` 初始强制 off。可新增 `GET /zone/:id/dev-mode` 读取当前值以正确初始化 Switch，消除「点开却无变化」的误导（作者自审 §4 已列为待补）。
- **同步事务化**：除 #1 的修复外，可考虑在 `cf_sync_runs` 记录里补充 `assets` 类型同步（当前 sync 仅记 `kind:'domains'`，`cf.ts:98,126,131`），便于区分资产拉取与域名落库。
- **SSL 失败计数/告警**：`getZoneSslDaysLeft` 返回 null 时可顺带累加失败 zone 数并在 `/assets` 响应中透出，帮助判断是「真无证书」还是「读取失败」。
- **幂等保护**：`POST /sync` 无并发锁，重复快速点击会并发 clear+upsert；可在 route 层加简单 in-flight 标记或依赖前端 `syncing` 状态（当前已有 `CFAssets.tsx:60,85-96` 的 `syncing` 前端防重，但仅单标签页有效）。
- **迁移落地提示**：`6_site_monitor.sql` 含 ALTER/建表/RPC，需在目标 Supabase 重新 apply（`supabase db push` 或 Dashboard）后 5 个 RPC 才生效，部署清单应显式包含此步（作者自审 §4 已提及）。

---

### 附：与作者自审（VERIFICATION）的对照
- 作者声称「无明文令牌 / tsc 0 错误 / requireCredentials 全 await / 权限降级优雅失败 / 原子替换」——独立审议确认前 3 项成立；第 4 项（权限降级）确已结构化（`reason:'permission'`，路由 403），成立；第 5 项「原子替换」**与代码不符**：`clearCfDomains`+`upsertCfDomains` 实际为两次独立 RPC，并非原子（见 ③#1）。此点作者在自审中表述偏乐观，提请修正认知。

---

### 附：作者后续修复记录（非独立审议，仅追加）

> 本段由主代理在收到独立审议后追加，**不改变**上方独立审议结论（`<!-- reviewed-by: independent-subagent -->` 仍为原审议）。所列修复均经 `build:migrations` / worker `tsc --noEmit` / frontend `vite build` 实测复验通过。

- **③#1（非原子同步）**：已将 `cfm_clear_cf_domains` + `cfm_upsert_cf_domains` 合并为单事务 RPC `cfm_sync_cf_domains(input_rows jsonb)`（plpgsql 内先 upsert 输入集、再 `delete ... where not exists (输入集)`，整段事务；任一步异常整体回滚，绝不留空表）。迁移、适配器（`syncSupabaseCfDomains`）、queries（`syncCfDomains`）、route（去除 `clear`+`upsert`，改为 `syncCfDomains`，并对空输入跳过以防误删全表）同步改造。
- **③#2（嵌套 zone 误配）**：`matchZoneId` 改为按 zone name 长度降序匹配，最具体 zone 优先。
- **③#3（SSL 静默吞错）**：`getZoneSslDaysLeft` 的 catch 内补 `console.error`，保留 null 降级。
- **③#4（面包屑缺失）**：`getAdminSectionTitle` 补 `if (pathname.startsWith('/admin/cf')) return 'CF 资产'`。
- **UX（dev-mode 不回显）**：新增 `GET /zone/:id/dev-mode` + `CloudflareApi.getDevMode` + 前端加载后并行拉取各 zone 当前状态回显 Switch。
- **自审认知修正**：VERIFICATION 原「原子替换」表述已改为「单事务 RPC」，与代码一致。
