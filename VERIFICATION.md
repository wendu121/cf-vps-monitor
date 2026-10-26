# 交付前自审 (VERIFICATION) — 上游精选移植 B3「指标可用性」

> 本轮覆盖工作树中**仅属于 B3** 的改动：已跟踪文件 **35 个 / +1353 / −293**
> （不含 VERIFICATION.md / REVIEW.md 两个文档），**另加 1 个未跟踪新增迁移**
> `supabase/migrations/11_metric_availability.sql`（提交时须显式 `git add`，
> `git commit -am` 会漏掉它）。
> 上一轮（B1+B2，commit `a092297`）的 VERIFICATION/REVIEW 已被本文件取代，
> 原文可从 `git show a092297:VERIFICATION.md` / `git show a092297:REVIEW.md` 取回。
>
> **明确不在本次提交范围**：boss 既有的 CF Tunnel WIP（已存入 `stash@{0}`，
> 含 `cf-client.ts`、`cf-sync.ts`、`CFAssets.tsx`、`10_cf_tunnel_domains.sql`、
> `cf-client.test.mjs`、`scripts/generate-migrations.mjs` 与 `scripts/test-support/postgres.mjs`
> 的 CF 相关片段等），完成后必须 `git stash pop` 恢复。

## 交付范围

| 层 | 文件 | 内容 |
|---|---|---|
| Agent（Go） | 新增 `metric_availability.go` / `memory_scope.go` / `cgroup_cpu.go`；改 `cgroup_memory.go` / `main.go` | 指标改为可空指针；新增 `cpu_capacity`、`metric_errors`；CPU 走 cgroup 配额 + cgroup 计数；内存区分 lxcfs 与容器作用域 |
| Agent 测试 | 新增 `audit_metric_availability_test.go` / `audit_swap_scope_test.go`；适配 4 个既有测试的类型 | 显式 null ≠ 0、网络恢复重建基线、容器 swap 不得借宿主机 |
| Worker | `monitor-report.ts` / `public-report.ts` / `db/types.ts` | 归一化改为可空；`selectMetricAvailability` 白名单过滤三种固定原因，拒绝任意诊断文本外泄 |
| 前端 | `liveDataResponse.ts` / `LiveDataContext.tsx` / `nodeMetrics.ts` / `monitorView.ts` / `monitorChartData.ts` / `dashboardStatus.ts` / `publicHistory.ts` / `DetailsGrid.tsx` / `NodeCard.tsx` / `NodeTable.tsx` | null 贯穿展示与聚合；不可用排在真实 0 之后；`sumMetrics` 任一未知则总计未知 |
| Schema | 新增 `supabase/migrations/11_metric_availability.sql` + 重新生成 `generated/supabase-migrations.ts` | `records` 9 列 `drop not null`；重定义 `cfm_insert_monitor_record`（缺字段仍 0、显式 null 存 null）与 `cfm_load_metric_window_stats`（`metric_value is not null` 过滤） |

## 一、已验证项 (Verified)

| # | 结论 | 验证命令 / 依据（实证） | 结果 |
|---|---|---|---|
| 1 | Agent 编译通过 | `cd agent && go build ./...` | EXIT=0，无输出 |
| 2 | Agent 静态检查通过 | `cd agent && go vet ./...` | EXIT=0，无输出 |
| 3 | Agent 全量测试通过 | `cd agent && go test ./...` | `ok github.com/cf-vps-monitor/agent 31.548s`（含新入的 `TestAuditUnavailableMetricsAreExplicitNull`、`TestAuditKnownMetricZerosRemainZero`、`TestAuditUnavailableNetworkRecoveryRebuildsBaseline`、`TestAuditSwapUnlimitedOrUnreadableDoesNotAuthorizeHostFallback`） |
| 4 | Report JSON 契约：未采集即 null | `agent/main.go:170-177` 中 `CPU/RAM/Swap/Net*` 均为裸指针无 `omitempty`，仅 `cpu_capacity`/`metric_errors` 带 `omitempty`；由 `TestAuditUnavailableMetricsAreExplicitNull` 实测通过 | 已落地 |
| 5 | 网络不可用不得当成空闲 | `agent/main.go:3086-3090` `if !report.hasRawNetTotals && (NetTotalUp==nil || NetTotalDown==nil)` → 置 null + `collection_failed` + `p.ready=false` | 已落地 |
| 6 | 网络恢复重建基线 | 同上两处早退分支写 `warming_up`；`agent/main.go:3151-3153` 恢复成功时 `delete(report.MetricErrors,"network")`；`TestAuditUnavailableNetworkRecoveryRebuildsBaseline` 实测通过 | 已落地 |
| 7 | 扫源码的回归锁未假绿 | `agent/main_test.go:1006-1012` 已把 `metric_availability.go` 拼进 `source`，否则 `TestTrafficAndRateCallSitesUseOneSelection` 会因采集点搬家而空转 | 已落地 |
| 8 | Worker 类型检查通过 | `cd worker && ./node_modules/typescript/bin/tsc --noEmit` | EXIT=0，无输出 |
| 9 | Worker 全量测试通过 | `cd worker && node --test` | **531 tests / 531 pass / 0 fail** |
| 10 | Worker 归一化+持久化+公开投影链路 | `node --test src/utils/monitor-report.metric-availability.audit.test.mjs` | **13/13 pass** |
| 11 | 真实 SQL 链路（HTTP/WebSocket→SQL→公开历史→冷状态） | `node --test test/audit-metric-availability-runtime.test.mjs` | **1/1 pass**（11.0s，pglite 真实建库） |
| 12 | 迁移确实把 9 列改为可空 | 直连 `createTestDatabase()` 查 `information_schema.columns` | `cpu/ram/ram_total/swap/swap_total/net_in/net_out/net_total_up/net_total_down` 全部 `is_nullable=YES` |
| 13 | 前端类型检查通过 | `cd frontend && ./node_modules/.bin/tsc -b` | EXIT=0，无输出 |
| 14 | 前端全量测试通过 | `cd frontend && node --test` | **150 tests / 150 pass / 0 fail** |
| 15 | 前端指标可用性审计 | `node --test test/metric-availability.audit.test.mjs` | **24/24 pass** |
| 16 | 单条不可用指标不再吞掉整行历史 | `frontend/src/utils/publicHistory.ts` 用 `nullableNumberField`（null 保留、undefined 才丢整行）替换 `loadField`；`publicHistory.load-unavailable.test.mjs` 断言 `{cpu:null}` 保留行、`{cpu:'high'}` 丢弃 | 已落地 |

## 二、本轮暴露并现场修掉的真实缺陷

**迁移编号进两位数后字符串排序错位**（实测踩到，非推断）：

- 现象：首次跑 `test/audit-metric-availability-runtime.test.mjs` 与既有 `offline-state-runtime.test.mjs` 同时报
  `relation "public.records" does not exist`（code `42P01`）。
- 根因：`11_metric_availability.sql` 按字典序排在 `1_core_schema.sql` 之后、`2_security_access.sql` 之前，
  于是 `alter table public.records` 先于建表执行，整条迁移链中断。
- 修法：`scripts/generate-migrations.mjs`、`scripts/test-support/postgres.mjs`、
  `migration-signatures.test.mjs`、`migration-column-order.test.mjs` 四处统一改自然排序
  `a.localeCompare(b,'en',{numeric:true})`；`node scripts/generate-migrations.mjs` 后核对
  `generated/supabase-migrations.ts` 版本顺序为 `1,2,…,9,11`。
- 附带影响：boss WIP 里的 `10_cf_tunnel_domains.sql` 同样会踩这个坑，本次一并解决。

另修：`website-migration.reaudit.test.mjs` 原硬编码 `applied === 9`，改为从
`BUNDLED_SUPABASE_MIGRATIONS.length` 推导（与上游同款写法），避免每加一条迁移都要手改数字——
这也保证 boss 的迁移 10 合入后该用例不会假红。

## 三、语义变更（需 boss 知情，非等价移植）

本地 fork 原先对容器 swap 做了「清零假装 0」的处理（`mergeMemorySnapshot`：LXC 下
`swapTotal > ramTotal*4` 就把 swap 归零，或直接取宿主 proc 值）。B3 上游改为**标记不可用**：

- `mergeMemorySnapshot` 采用上游简化版：容器且非 proc-scoped 先把快照清空，只有 cgroup 明确给出
  swap 才采信；否则 `hasSwap=false` → 上报 `swap: null` + `metric_errors.swap=container_scope_unavailable`。
- 理由：清零仍是在说谎（0 会被读成「没有用 swap」），而 `audit_swap_scope_test.go` 明确断言
  「unavailable container swap must remain unavailable instead of borrowing host totals」。
- 影响：LXC 节点 swap 面板会从 `0` 变成 `—`。这是**预期行为**，不是显示 bug。
- 同步改了两个 fork 自有测试（`TestMergeMemorySnapshotLeavesContainerSwapUnknownWhenCgroupSwapMissing`、
  `TestMergeMemorySnapshotRespectsLargeExplicitCgroupSwap`）以匹配上游语义。

## 四、未验证项 (Unverified)

- **未在真实 LXC / 受限 cgroup 主机上实测**：`procFileIsLXCFS`、`cgroupCPUSnapshot` 的判定只在
  单元测试与 fixture 目录（`t.TempDir()` 写 cgroup 文件）中验证，未在真实 lxcfs 挂载环境跑。
- **未真实升级既有 Agent 二进制**：`go build` 通过但未替换线上 Agent，也未验证「旧 Agent 上报
  缺字段 → 服务端按 0 存」的兼容路径（该路径由迁移中的 `jsonb ? 'cpu'` 分支与
  `normalizeMonitorReport` 的缺失字段测试覆盖，属逻辑验证，非端到端）。
- **未对生产 Supabase 执行迁移**：迁移只在 pglite（`@electric-sql/pglite`）上验证过；
  `notify pgrst, 'reload schema'` 与真实 PG 版本差异未实测。
- **未做 wrangler 部署 / 冒烟**：未跑 `wrangler deploy` 或 `--dry-run`。
- **未移植上游配套的其它 B 项**：`MiniPingChart` 懒加载（B-性能，已在 `NodeTable.tsx` 显式还原）、
  `logging.go`（`verboseLogf`，本地 `logReport` 仍用 `log.Printf`）、
  `publicHistory` 的 `HistoryIdentity/id` 游标分页、`frontend/browser/full-audit-regressions.mjs`
  浏览器审计。上述均**未**引入，`frontend/test/metric-availability.audit.test.mjs` 中相应的
  `id` 断言已删除并在文件内注明原因。
- **未验证 Durable Object 冷启动持久化在真实 CF 环境**：`persistDurableObjects` 走 miniflare 本地路径。

## 五、信息源与置信度

- 上游来源：本地 git 对象 `6ddadff`（`kadidalax/cf-monitor-test` dev 分支，未发布），基线为
  `7f63112`（内容等价 v2.0.3）。非网络实时读取。
- 行为结论：来自实际命令输出（编译/vet/test/直连查表），**置信度高**。
- 未验证项均属环境与集成层，**置信度中**，已如实列出，未声称已完成。
- 迁移编号 11 而非上游 8：本地已有 6–9，且 boss WIP 占用 10，故重编号为 11。
