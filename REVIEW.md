<!-- reviewed-by: independent-subagent -->
# 独立审议报告 — F4 SLA 月报月份解析修复（HEAD=933db42，工作区未提交）

- 审议角色：独立审议者（门下省式，独立复现，不采信交付方自述）
- 审议日期：2026-09-23
- 交付物：`supabase/migrations/7_sla_month_fix.sql`（新增）+ `worker/src/generated/supabase-migrations.ts`（生成物，+6 行）
- 验证栈：本地 `validate-db-1`（postgres:15-alpine，库 `cfmonitor`，datestyle=ISO,MDY，已灌入 monitor_id=901 + 10 行 checks 含 8 成功）；线上 `https://mon.hqa.kdns.fr`（admin 凭据来自 `E:\第二电脑\_admin_credentials.txt`）

## 一、审议结论

**结论：有条件 PASS**

- 代码修复本身经独立复现验证为**正确且有效**，前后对照字段全部吻合公式，无阻断性缺陷。
- 唯一“未闭环”项是**修复尚未上线**：线上 `/api/admin/ops/sla` 实测仍为 502（本人独立确认）。交付方已明示此状态，故其属部署缺口而非代码缺陷，列为通过条件。
- 非阻断发现 F-01 / F-02 / F-03，均不影响修复正确性，须择机修补。

> 若仅以“代码交付物正确性”为标尺，可判 PASS；因生产侧缺陷（F4 面板 100% 不可用）在补丁应用前依旧存在，故加“有条件”，条件见第五节。

## 二、本人亲自执行的命令与实测输出

### 任务 1：独立复现根因
```
$ docker exec validate-db-1 psql -U postgres -d cfmonitor -tAc "show datestyle; select '2026-09'::date;"
ISO, MDY
ERROR:  invalid input syntax for type date: "2026-09"
LINE 1: show datestyle; select '2026-09'::date; ...
```
- `datestyle = ISO, MDY`，`'2026-09'::date` 确报 22007（与 VERIFICATION.md 断言 #2 一致）。
- 读取 `supabase/migrations/6_site_monitor.sql:191`，原文确为：
  `date_trunc('month', coalesce(nullif(input->>'month', ''), to_char(now(), 'YYYY-MM'))::date) as m_start`

### 任务 2：独立复现 bug + 验证“空表不报错”说法
```
$ select cfm_website_sla_report('{}'::jsonb);
ERROR:  invalid input syntax for type date: "2026-09"
CONTEXT:  SQL function "cfm_website_sla_report" statement 1

$ select cfm_website_sla_report('{"month":"2026-09"}'::jsonb);
ERROR:  invalid input syntax for type date: "2026-09"
CONTEXT:  SQL function "cfm_website_sla_report" statement 1

$ begin; delete from website_checks where monitor_id=901; select cfm_website_sla_report('{}'::jsonb); rollback;
BEGIN
DELETE 10
ERROR:  invalid input syntax for type date: "2026-09"   ← 注意：空 website_checks 仍报错，未返回 []
```
- 两条入参路径（缺省 / 显式 2026-09）均报 22007，bug 复现成功。
- **反驳 VERIFICATION.md §六**：交付方声称“空表时不求值内层子查询、返回 `[]`”。本人实测：删空 `website_checks` 后函数**仍报 22007**。原因：`bounds` 是 CTE，Postgres 默认将其物化（优化屏障），与外层是否 0 行无关，故非法转换必然执行。该自述说法**失实**（详见 F-01）。

### 任务 3：独立复现修法 + 边界
```
$ select to_date('2026-09','YYYY-MM');        => 2026-09-01
$ select to_date('2026-13','YYYY-MM');        => ERROR: date/time field value out of range: "2026-13"
$ select to_date('','YYYY-MM');               => 0001-01-01 BC
```
- 与 VERIFICATION.md §三 表描述**完全一致**（修法有效；`2026-13` 抛出范围错；空串静默成 `0001-01-01 BC`）。

### 任务 4：守卫副作用审查（读 `worker/src/routes/ops.ts`）
- `parseMonth()`（ops.ts:24-27）逻辑：
  - 无值 → `currentMonth()`（=`new Date().toISOString().slice(0,7)`，严格 `YYYY-MM`）
  - 有值且匹配 `/^\d{4}-\d{2}$/` → 原值；否则回落当月。
- 迁移守卫正则 `^[0-9]{4}-(0[1-9]|1[0-2])$` 覆盖 `parseMonth` 的**全部合法输出**（真实月份 01–12），无误杀合法输入。
- 但 `parseMonth` 正则放行 `2026-00`/`2026-13`..`2026-99` 这类“格式合法但月份非法”的值，守卫会回落当月——属预期。详见 F-02。

### 任务 5：应用迁移并做前后对照（核心动作）
- 修复前（未应用 7 号迁移）：函数调用报 22007（见任务 2）。
- 应用：`docker exec -i validate-db-1 psql -U postgres -d cfmonitor < supabase/migrations/7_sla_month_fix.sql`
  输出：`SET / CREATE FUNCTION / REVOKE×3 / GRANT`（一例良性 WARNING：`SET LOCAL can only be used in transaction blocks`，因我未包事务执行；函数体自带 `set search_path=public` 不受影响，见 F-03）。
- 应用后逐字段实测（`interval_sec=120`，10 行含 8 成功）：
```
$ select cfm_website_sla_report('{}'::jsonb);
[{"url":"https://example.com/","name":"SLA 验证站点","sla_pct":80.000,"up_checks":8,
  "monitor_id":901,"downtime_min":4.0,"interval_sec":120,"total_checks":10,
  "avg_latency_ms":106,"last_checked_at":"2026-09-01T00:10:00+00:00"}]
```
- 字段核对：`monitor_id=901`✓ `name`✓ `url`✓ `interval_sec=120`✓ `total_checks=10`✓ `up_checks=8`✓ `sla_pct=80.000`✓（=8/10×100）`downtime_min=4.0`✓（=(10−8)×120/60=4.0）`avg_latency_ms=106`✓ `last_checked_at`✓
- 边界入参（均不报错且行为合理）：
  - `{"month":"2026-09"}` → 同上数据（正确）
  - `{"month":"2026-13"}` → 回落当月，返回 2026-09 数据，**无错**
  - `{"month":""}` / `{"month":"   "}` / `{"month":"abc"}` → 均回落当月，无错
  - `{"month":"2020-01"}` → `[]`（无数据，无错）
- 结论：修复前后对照成立，公式与字段全部吻合。

### 任务 6：核对生成物未被手改
```
$ git hash-object worker/src/generated/supabase-migrations.ts   # 应用前
67f16ce334afdc236dc565c5053a4c285ac7743d
$ node scripts/generate-migrations.mjs                          # 用托管 node 22.22.2-3
Generated 7 Supabase migrations.
$ git hash-object worker/src/generated/supabase-migrations.ts   # 重生成后
8341c25c8157563897a99721c00a7eb1b73dda33
$ git --no-pager diff --stat worker/src/generated/supabase-migrations.ts
 worker/src/generated/supabase-migrations.ts | 6 ++++++
```
- 重生成前后 `git diff --stat` **均为 +6 行**（vs HEAD），内容无新增差异。
- hash 不同仅因行尾（CRLF↔LF）：`git` 归一化后 `diff --stat` 一致，证明**生成物未被手改**，仅为行尾差异。
- 生成文件第 7 条目（`"version":"7_sla_month_fix"`）的 `sql` 内容与 `7_sla_month_fix.sql` 实质一致（JSON 转义 `\n`、`\\d` 属预期），无篡改。

### 任务 7：核对授权语句
- `7_sla_month_fix.sql:78-81`：
  `revoke all ... from public; from anon; from authenticated; grant execute ... to service_role;`
- 与 `6_site_monitor.sql:391-394` 同函数收尾写法**逐字一致**。
- 实测权限：`has_function_privilege` → anon=f, authenticated=f, service_role=t, public=f。
- 结论：**未把函数暴露给 anon**，与既有函数一致。

### 任务 8：复核“未上线”结论（线上独立确认）
- 用 `_probe_node.mjs` 的 IP 兜底（`mon.hqa.kdns.fr`→`172.67.147.155`，`servername` 保真域名）+ 登录/CSRF 流程，管理员会话 GET：
```
[login] HTTP 200 csrf_len=43 cookies=cf_monitor_session,cf_monitor_csrf
[sla] HTTP 502 body={"month":"2026-09","rows":[],"error":"Supabase RPC cfm_website_sla_report failed: 400 {\"code\":\"22007\",...\"message\":\"invalid input syntax for type date: \\\"2026-09\\\"\"}"}
[sla?month=2026-09] HTTP 502  (同上错误)
```
- 结论：线上**确实仍为 502**，错误信息与本地根因一致。交付方“未上线”结论**属实**，非误判。

### 任务 9：查同类缺陷
- `supabase/migrations/*.sql` 中 `::date|::timestamp|::timestamptz` 检索：
  - `6_site_monitor.sql:191` —— 本次修复对象（已修）。
  - `6_site_monitor.sql:143` `coalesce((x->>'synced_at')::timestamptz, now())`：对完整 timestamptz 文本强转，非 `YYYY-MM` 形态，不属同类缺陷。
  - `4_rpc_api.sql` 多处 `::timestamptz`：操作完整时间戳或 `'1970-01-01'::timestamptz` 之类完整字面量，无 `YYYY-MM` 文本强转。
- `worker/src/**` 检索 `YYYY-MM|to_date|::date|date_trunc|to_char(now()`（排除 generated）：
  - 仅 `worker/src/routes/ops.ts:35` 注释命中，无 TS 侧 `YYYY-MM`→date 强转。
- 结论：**未发现其它把 `YYYY-MM` 文本直接 `::date/::timestamp` 强转的位置**。

## 三、各补审任务结论一览

| # | 任务 | 结论 |
|---|---|---|
| 1 | 复现根因 `'2026-09'::date` 报 22007 + 读 6_site_monitor.sql:191 | 成立（实测报错，源码确为 `::date` 强转） |
| 2 | 复现 bug（两条路径） | 成立（均报 22007） |
| 2b | 验证“空表不报错返回 `[]`”说法 | **不成立**——空 `website_checks` 仍报 22007（见 F-01） |
| 3 | 复现修法 + 两边界 | 成立（与自述一致） |
| 4 | 守卫覆盖 `parseMonth` 全部输出、无误杀 | 成立；另发现 F-02 标签错配 |
| 5 | 应用迁移 + 前后对照 + 边界 + 公式 | 成立（字段/公式全吻合） |
| 6 | 生成物未被手改 | 成立（仅行尾差异，`diff --stat` 一致） |
| 7 | 授权一致且未暴露 anon | 成立（anon=f, sr=t） |
| 8 | 线上仍 502（未上线） | 成立（独立实测 502） |
| 9 | 同类缺陷检索 | 未发现其它 `YYYY-MM` 强转 |

## 四、非阻断发现

**F-01（文档失实，非阻断）**：VERIFICATION.md §六称“空表时 `website_checks` 外层 0 行、不求值 `bounds` 子查询、返回 `[]`”。本人实测：删空 `website_checks` 后函数**仍报 22007**。`bounds` 为 CTE，Postgres 默认物化（优化屏障），与外层行数无关，非法转换必执行。交付方该条方法论述失实；不影响修复正确性，但建议在 VERIFICATION.md 中更正，以免误导后续判断。

**F-02（响应标签错配，非阻断，建议修）**：当请求非法但格式合法的月份（如 `?month=2026-13`）时，SQL 守卫静默回落当月，但 `worker/src/routes/ops.ts:41` 仍把原始 `month`（`"2026-13"`）回显在响应体 `{month, rows}` 中。前端会显示“月份 2026-13”却呈现当月数据，属静默错标。建议：路由层 `parseMonth` 与 SQL 守卫正则对齐（均只允许 01–12），或回显“实际生效月份”。不在本轮 502 修复范围内，列为建议项。

**F-03（良性告警，非阻断）**：`7_sla_month_fix.sql:26` 的 `set local search_path = public;` 在脱离事务执行时触发 `WARNING: SET LOCAL can only be used in transaction blocks`（本人直连 psql 执行即此情形）。函数体自带 `set search_path = public` 保证安全；Supabase 迁移实际以事务执行该告警不出现。写法与 `6_site_monitor.sql` 一致，非缺陷。

## 五、通过条件 / 阻断点

- **阻断点：无。** 代码修复正确、局部、低风险，已端到端验证；授权与生成物均合规。
- **通过条件**：
  1. **部署闭环**：须将 `7_sla_month_fix.sql` 应用到线上 Supabase（需 PAT 或在 SQL Editor 粘贴执行），方可真正消除 F4 面板 502。在应用前，生产侧缺陷依旧（本人已实测线上 502）。
  2. **择机修补 F-02**（响应月份标签错配）；F-01 仅更正文档即可。

## 六、给自动化门禁的判定

- 判定标记：`有条件 PASS`
- 署名标记：`<!-- reviewed-by: independent-subagent -->`（见文件首行）
- 未放行项：仅“生产部署”与两条非阻断建议，无任何阻断性缺陷。
