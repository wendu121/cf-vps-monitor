# 交付前自审 (VERIFICATION) — 闭环 follow-up #1

> 本文件是门下省门禁要求的自审证据。覆盖 `cf-vps-monitor-src` 本次工作树改动（5 个文件：
> 1 个新迁移 + 3 个测试改动 + 1 个重生成文件）。门禁三道闸：① 校验关（已跑）② 自审关（本文件）
> ③ 独立审议关（REVIEW.md）。凡「已改/已验证」的断言，均附紧随其后的实证（文件:行号 或 命令结果）。
>
> 背景：上一轮（HEAD `e86a7c7`）修复了**导出侧**——`backup.ts` 的 `websiteMonitorConfiguration`
> 现在带出 `source`/`cf_zone_id`/`cf_project_name`。但**恢复侧** `cfm_restore_backup_data` 仍不接收/写回
> 这三列，被评审标记为「已知半修复·未闭环」。本轮用迁移 9 补上恢复侧，闭合导出→还原全链路。

## 一、已验证项 (Verified)

| # | 结论 | 验证命令 / 依据（实证） | 结果 |
|---|---|---|---|
| 1 | 类型检查通过（worker） | `node .../typescript/bin/tsc --noEmit -p E:/工作站/cf-vps-monitor-src/worker/tsconfig.json`（沙箱无 sed/dirname，直跑绕过 `.bin` shim） | **EXIT=0，0 报错** |
| 2 | 全量 worker 测试通过 | `node --experimental-strip-types --test`（PGlite 内嵌，自包含） | **512 用例 / 512 通过 / 0 失败**（`# pass 512 # fail 0`，见 `output/full-test.log`） |
| 3 | 新增迁移 9：恢复 RPC 补 CF 3 列（INSERT） | `supabase/migrations/9_restore_cf_source.sql:216` 列清单加 `source, cf_zone_id, cf_project_name`；`:230-232` 取值 `case … else 'manual' end` / `nullif(...,'')` | 已落地，见下实证 |
| 4 | 新增迁移 9：恢复 RPC 补 CF 3 列（ON CONFLICT DO UPDATE） | `9_restore_cf_source.sql:247-249` 用 `website_monitors.<col>` 指代现有行，备份未携带则保留线上值 | 已落地，见下实证 |
| 5 | 修复真实 bug：`column reference "source" is ambiguous` (PG 42702) | 首跑测试报 `42702`——`INSERT … ON CONFLICT DO UPDATE SET` 中裸列名在 target 表与 `excluded` 间歧义；改为 `website_monitors.source/cf_zone_id/cf_project_name` 后复跑全绿 | 真 bug，已修，测试实证 |
| 6 | 重生成文件含 9 条迁移 | `grep '"version": "9_restore_cf_source"' worker/src/generated/supabase-migrations.ts` → 命中（行 60）；全量 `version` 列表 1→9 连续 | 已落地 |
| 7 | 迁移注册表测试更新为 9 条 | `git diff migration-signatures.test.mjs` → 两个 `deepEqual` 列表各加 `'9_restore_cf_source.sql'` / `'9_restore_cf_source'` | 已落地，全量测试 #2 通过 |
| 8 | 重审计测试 8→9 | `git diff website-migration.reaudit.test.mjs` → `assert.equal((await apply()).applied, 9)`（行 51） | 已落地，全量测试通过 |
| 9 | 新增回归测试：非默认 CF 值经还原不丢 | `git diff backup-website-restore.test.mjs`（+70 行）新增 `AUD-06 restore preserves non-default CF attribution`：建 `cf_worker` 监控项带 `cf_zone_id/cf_project_name`，还原前后断言一致，并验证 ON CONFLICT 覆盖路径 | 已落地，全量测试 #10 通过 |
| 10 | 迁移幂等，可安全重跑 | `9_restore_cf_source.sql` 用 `create or replace function … cfm_restore_backup_data` + 重声明 `revoke/grant` + `set local search_path`；与迁移 8 同模式 | 设计保证，PGlite 重跑全绿 |

### 实证细节（grep / diff 摘录）

- `supabase/migrations/9_restore_cf_source.sql:216`（INSERT 列清单，紧跟 `agent_probe_status_enabled` 之后）：
  ```sql
          source, cf_zone_id, cf_project_name,
  ```
- `9_restore_cf_source.sql:230-232`（INSERT 取值，CHECK 守卫 + 空串转 NULL）：
  ```sql
          case when item->>'source' in ('manual', 'cf_worker', 'cf_pages') then item->>'source' else 'manual' end,
          nullif(item->>'cf_zone_id', ''),
          nullif(item->>'cf_project_name', ''),
  ```
- `9_restore_cf_source.sql:247-249`（ON CONFLICT DO UPDATE，保留现有值语义）：
  ```sql
          source = case when item->>'source' in ('manual', 'cf_worker', 'cf_pages') then item->>'source' else website_monitors.source end,
          cf_zone_id = coalesce(nullif(item->>'cf_zone_id', ''), website_monitors.cf_zone_id),
          cf_project_name = coalesce(nullif(item->>'cf_project_name', ''), website_monitors.cf_project_name),
  ```
- 校验命令原始结果：`EXIT_TSC=0`；`# tests 512 / # pass 512 / # fail 0`。
- 首跑失败实证（已修）：`error: 'column reference "source" is ambiguous'  code: '42702'` —— 来自 ON CONFLICT DO UPDATE 裸列名歧义。

## 二、未验证项 (Unverified) — 诚实边界

- **[必须后续] 尚未 commit**：工作树 5 个文件改动未提交，故未部署。迁移 9 要生效须 `commit` 后重新部署，由 `POST /api/setup/database/init`（Management API）或 Worker 启动幂等应用。此为信息源（部署脚本 + 先前记录），非本次实测。
- **[必须后续] 尚未重新部署上线**：上一轮部署 `e86a7c7` 的线上 DB 尚无迁移 9。commit 后必须 `npm run deploy`（或 `deploy-cloudflare.mjs` + `--keep-vars`）让迁移 9 在线上落库。
- **[环境性 · 非代码回归] 沙箱无法访问 `*.workers.dev` 用户域名**：wrangler 经 `api.cloudflare.com` 部署成功，但本地 `curl/node fetch` 到用户域失败（exit 7 / fetch failed）。故部署后线上实测需 boss 在浏览器自检；wrangler 输出 `CURRENT_GIT_COMMIT bound=…` 为权威证据。与本次改动无关。
- **[低风险 · 行尾] 生成文件 LF/CRLF 警告**：`git diff` 对 `supabase-migrations.ts` 提示 `LF will be replaced by CRLF`——仅行尾差异，无功能影响。

## 三、信息源与置信度

- **已独立验证（高置信）**：项 1-10 均来自本次 `git diff` / `grep` 实测 + `tsc` / `node --test` 实测输出，非凭记忆。
- **作者/模型推断、未实测（中/低置信）**：部署后线上状态（项·未验证-1/2）基于先前会话记录与部署脚本推断，须 commit+redeploy 后实测闭环。
- **环境约束说明**：沙箱内 `tail`/`sed`/`dirname`/`uname` 不可用且 `wsl.exe` 被安全策略拦截，故管道 `| tail` 失败、`.bin` shim 不可用；已改用「`node` 直跑 `typescript/bin/tsc` + 显式 Windows 绝对路径」与「输出重定向到文件 + Grep」绕过，结果真实有效。

## 四、交付物清单（待 commit）

```
?? supabase/migrations/9_restore_cf_source.sql        (新增：闭合恢复侧 CF 归属)
M  worker/src/db/supabase-api/backup-website-restore.test.mjs   (+70 行回归测试)
M  worker/src/db/supabase-api/migration-signatures.test.mjs     (+2 行：9 条)
M  worker/src/db/supabase-api/website-migration.reaudit.test.mjs (1 行：8→9)
M  worker/src/generated/supabase-migrations.ts                  (重生成：9 条)
```
注：本轮回溯关闭了上一轮 VERIFICATION.md 标记的「已知半修复·未闭环」（恢复 RPC 不带 CF 3 列）。
