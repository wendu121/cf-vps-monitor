# 交付前自审 (VERIFICATION) — 上游精选移植 B1+B2

> 本文件是门下省门禁要求的自审证据，覆盖本次工作树中 **仅属于 B1+B2** 的 5 个文件改动。
> 上一轮（HEAD `3f89905`，迁移 9 闭环）的 VERIFICATION/REVIEW 记录已被本文件取代，
> 原文可从 `git show 3f89905:VERIFICATION.md` / `git show 3f89905:REVIEW.md` 取回。
>
> **明确不在本次提交范围**：boss 既有的 CF Tunnel WIP（`cf-client.ts`、`cf-sync.ts`、
> `CFAssets.tsx`、`scripts/*`、`db/types.ts`、`generated/supabase-migrations.ts`、
> `migration-signatures.test.mjs`、`10_cf_tunnel_domains.sql`、`cf-client.test.mjs`），
> 以及 B3「指标可用性」。

## 交付范围

| 项 | 来源 | 说明 |
|---|---|---|
| B1 Windows 停止竞态 | 上游 `kadidalax/cf-monitor-test@69bbda4` | 停止进程改用进程对象，规避 PID 复用竞态 |
| B2 健康状态恢复 | 上游 `kadidalax/cf-monitor-test@bc6e390`（仅 observability 部分） | 删除进程内成功节流缓存，恢复以 DB 为准 |

## 一、已验证项 (Verified)

| # | 结论 | 验证命令 / 依据（实证） | 结果 |
|---|---|---|---|
| 1 | Windows 停止改用进程对象 | `grep -n "Stop-Process -InputObject" agent/install-windows.ps1` → `494:    Stop-Process -InputObject $process -Force -ErrorAction Stop` | 已落地 |
| 2 | 4 个停止场景夹具可执行 | `node --test agent/install-windows-safety.test.mjs` | **16/16 pass**（含 `CI02 native process stop handles running / exited-after-enumeration / stop-denied / stop-failed`） |
| 3 | 健康成功节流缓存已彻底移除 | `grep -rn "healthSuccessThrottleCache" worker/src/` | **0 命中** |
| 4 | 健康恢复行为符合预期 | `node --test worker/src/utils/observability.test.mjs worker/src/utils/observability-health-recovery.test.mjs` | **14/14 pass**（含 4 个新用例：同实例恢复、跨实例恢复、重复成功仍节流、无 DB / 读失败保留旧错误） |
| 5 | 三文件合并回归 | `node --test observability.test.mjs observability-health-recovery.test.mjs install-windows-safety.test.mjs` | **30 tests / 30 pass / 0 fail / 0 skipped** |
| 6 | Worker TypeScript 类型检查 | `node worker/node_modules/typescript/bin/tsc --noEmit -p worker/tsconfig.json` | **EXIT=0，无输出** |
| 7 | 改动范围未含 CF WIP | `git status --short` 对照提交清单 | 仅 5 个 B1+B2 文件被纳入 |

## 二、未验证项 (Unverified)

- **未在真实 Windows 服务安装/升级流程中实测**：只运行了 `pwsh` 夹具（`agent/testdata/windows-process-stop.ps1`），未真实安装 `CFVpsMonitorAgent` 服务做升级验证。
- **未跑全量 JS 测试套件**：只跑受影响的 3 个文件（30 用例）；其余用例是否存在回归属推断，未实测。
- **未跑 Go 测试**：本次未改动任何 `.go` 文件，仅改 PowerShell 与 TS/JS。
- **未做 wrangler dry-run / 生产部署验证**：本次改动不涉及 wrangler 配置或迁移，但部署链路未实测。
- **未验证真实 DO 多实例并发**：跨实例逻辑在单测中以两个 loader 实例模拟，非真实 Durable Object 并发。

## 三、信息源与置信度

- 上游改动来源：本地已 fetch 的 git 对象 `6ddadff` / `69bbda4`（`kadidalax/cf-monitor-test` 未发布版本），非网络实时读取。
- 行为结论依据：代码 diff + 本地测试实测，**置信度高**。
- `cron_client_sync` 组件**故意未引入**：它属于未移植的 client-sync 定时任务；单独加入 `STORED_HEALTH_COMPONENTS` 会被既有「孤儿组件」测试拦截（实测曾失败 2 例），因此新测试改用既有组件 `cron_cleanup`。
- 未验证项均属环境/集成层面，**置信度中**，已在「未验证项」如实列出，未声称已完成。
