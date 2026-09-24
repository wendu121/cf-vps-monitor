# 交付前自审 (VERIFICATION)

> 本文件是门下省门禁要求的自审证据。覆盖 `cf-vps-monitor-src` 本次会话的全部工作树改动
> （8 个文件）。门禁三道闸：① 校验关（已跑，见下）② 自审关（本文件）③ 独立审议关（REVIEW.md）。
> 凡「已改/已验证」的断言，均附紧随其后的 grep/Read 实证（含 文件:行号 或 命令结果）。

## 一、已验证项 (Verified)

| # | 结论 | 验证命令 / 依据（实证） | 结果 |
|---|---|---|---|
| 1 | 类型检查通过（worker） | `node worker/node_modules/typescript/bin/tsc --noEmit -p worker/tsconfig.json`（沙箱无 sed/dirname，绕过 `.bin` shim 直跑） | **EXIT=0，0 报错** |
| 2 | 三个含修复的测试文件全绿 | `node --test worker/src/db/supabase-api/migration-signatures.test.mjs worker/src/db/supabase-api/website-migration.reaudit.test.mjs worker/src/utils/observability.test.mjs` | **14 用例 / 14 通过 / 0 失败**（TAP `# pass 14 # fail 0`） |
| 3 | 真实 bug 修复：备份导出补回 CF 归属 3 列 | `git diff worker/src/utils/backup.ts` → 在 `websiteMonitorConfiguration` 返回对象新增 3 字段（`backup.ts:436-439`）：`source` / `cf_zone_id` / `cf_project_name` | 已落地，见 diff 实证 |
| 4 | 测试夹具同步补 3 字段 | `git diff scripts/test-support/backup-fixture.mjs` → 3 行 fixture 各加 `source:'manual', cf_zone_id:null, cf_project_name:null` | 已落地 |
| 5 | 迁移注册表测试更新为 8 条 | `git diff worker/src/db/supabase-api/migration-signatures.test.mjs` → 两个 `deepEqual` 列表各加 `6_site_monitor.sql`/`7_sla_month_fix.sql`/`8_sla_leftjoin_cf_source.sql`（行 13-15、23-25） | 已落地，测试 2 通过 |
| 6 | 重审计测试 5→8 | `git diff worker/src/db/supabase-api/website-migration.reaudit.test.mjs` → `assert.equal((await apply()).applied, 8)`（行 51） | 已落地，测试 1 通过 |
| 7 | observability 测试：补 mock + 计数 18→21 | `git diff worker/src/utils/observability.test.mjs` → 新增 `expireNotifications: async () => 0`（行 40）；`STORED_HEALTH_COMPONENTS.length` 断言 18→21（行 167） | 已落地，测试 12 通过 |
| 8 | 生成文件 `supabase-migrations.ts` 与 HEAD 内容一致 | `git diff` 该文件**为空**（仅 LF/CRLF 行尾差异）；且含 8 迁移的测试（项 2、5）通过 → 内容确为 8 迁移 | 内容一致，无功能风险 |
| 9 | 生成文件 `worker-configuration.d.ts` 为 wrangler 重生成 | `git diff` 仅改 binding 类型由字面量变 `string`（`SUPABASE_SECRET_KEY`/`JWT_SECRET` 现按实际值推断）+ hash 变更；与 `.dev.vars` 已填充一致 | 生成物，非手改，低风险 |
| 10 | `package-lock.json` 仅元数据清理 | `git diff` 删除 16 处 optional 原生依赖的 `libc:["glibc"/"musl"]` 字段（行 ~3804-4146）；无任何 dependency 增删 | 零功能影响 |

### 实证细节（grep / diff 摘录）

- `worker/src/utils/backup.ts:436-439`（修复核心）：
  ```ts
  source: monitor.source === 'cf_worker' || monitor.source === 'cf_pages' || monitor.source === 'manual' ? monitor.source : undefined,
  cf_zone_id: monitor.cf_zone_id ?? null,
  cf_project_name: monitor.cf_project_name ?? null,
  ```
- 校验命令原始结果：`EXIT_TSC=0`；`# tests 14 / # pass 14 / # fail 0`。

## 二、未验证项 (Unverified) — 诚实边界

- **[必须后续] 备份修复尚未上线（live 部署缺此修复）**：本次部署（`cdf1f237`，cron `*/2 * * * *`）用的是 `CURRENT_GIT_COMMIT=ae81a75`（当时 HEAD），
  工作树改动**未提交故未部署**。即线上 worker 仍跑旧 `backup.ts`，备份仍会丢弃 CF 归属 3 列。
  → **commit 后必须重新部署**才能使修复生效。此为信息源：部署脚本 `scripts/deploy-cloudflare.mjs` + 先前部署记录，非本次实测。
- **[已知半修复 · 未闭环] 恢复 RPC 仍不带 CF 3 列**：`cfm_restore_backup_data` 仍未接收/写回 `source`/`cf_zone_id`/`cf_project_name`。
  本次仅修了**导出侧**。恢复侧需新增迁移或改 RPC 入参（不在本次改动范围）。导出已带、恢复不带 → 备份可完整导出但回灌会丢 CF 归属。
  → 标记为高优先级 follow-up，本次不阻塞 commit。信息源：代码审阅（`backup.ts` 改动范围），未跑恢复端到端。
- **[环境性 · 非代码回归] 全量 `node --test` 仍有 111 失败 / 86 跳过**：根因是 Windows 沙箱缺 POSIX `sh`（`spawnSync sh ENOENT`，installer 类测试）与本地 dev server 未起（`test-login` `ECONNREFUSED 127.0.0.1:8787`）。
  与本次 6 处修复无关；先前已确认 30/30 受影响测试绿、全量 964/767 通过。信息源：前期分类统计，未重跑全量。
- **[旧 bug · 无关] `vite` 在 Windows 偶发卡死**：历史遗留，kill 进程可绕过，与本次改动无关。

## 三、信息源与置信度

- **已独立验证（高置信）**：项 1-10 均来自本次 `git diff` 实测 + `tsc`/`node --test` 实测输出，非凭记忆。
- **作者/模型自述、未独立验证（中/低置信）**：项 11-13 的线上状态与后续动作，基于先前会话记录与代码审阅推断，需 commit+redeploy 后实测闭环。
- **环境约束说明**：沙箱内 `tail`/`sed`/`dirname`/`uname` 不可用且 `wsl.exe` 被安全策略拦截，故 `npm run build` 的 `.bin` shim 与管道 `| tail` 均失败；
  已改用「`node` 直跑 `typescript/bin/tsc` + 显式 Windows 绝对路径」绕过，结果真实有效。

## 四、交付物清单（待 commit）

```
M package-lock.json
M scripts/test-support/backup-fixture.mjs
M worker/src/db/supabase-api/migration-signatures.test.mjs
M worker/src/db/supabase-api/website-migration.reaudit.test.mjs
M worker/src/generated/supabase-migrations.ts   (仅行尾差异)
M worker/src/utils/backup.ts                     (真实修复)
M worker/src/utils/observability.test.mjs
M worker/worker-configuration.d.ts               (wrangler 重生成)
```
注：`worker/.dev.vars`（含 `SUPABASE_ACCESS_TOKEN`，已写入）被 `.gitignore` 忽略，不在提交列表——属本地密钥，按安全约定不入库。
