<!-- reviewed-by: independent-subagent (rev2: post-doc-fix) -->
# 独立审议 (REVIEW) — 上游精选移植 B3「指标可用性」

> 审议方：独立 `general-purpose` 子代理（主代理完成自审后另行起，未参与实现）。
> 覆盖范围：工作区中 B3 全部改动（35 个已跟踪文件 + 1 个未跟踪迁移
> `supabase/migrations/11_metric_availability.sql`）。
> 结论：**PASS**，阻断项 0。

## 阻断项

无。

## 非阻断建议

1. **迁移 11 是未跟踪文件**：`git status` 显示 `?? supabase/migrations/11_metric_availability.sql`，
   `git diff HEAD` 不含它，因此自审开头的「35 文件 / +1353 / −293，含 1 个新增迁移」措辞不准确——
   该统计（排除 VERIFICATION.md 后复算正好 35 files / +1353 / −293）**不含**该未跟踪 .sql。
   提交时必须显式 `git add supabase/migrations/11_metric_availability.sql`，否则 `git commit -am`
   会漏掉迁移源文件（打包产物里虽有 SQL，但 `migration-signatures.test.mjs` 的源文件一致性会断裂）。
2. **`git stash pop` 大概率冲突**：`stash@{0}`（boss 的 CF Tunnel WIP）同时改了
   `scripts/generate-migrations.mjs`、`scripts/test-support/postgres.mjs`、
   `worker/src/db/supabase-api/migration-signatures.test.mjs`、
   `worker/src/generated/supabase-migrations.ts`。pop 后需保留双边：排序函数 + 迁移清单同时含 10 与 11，
   并重跑 `node scripts/generate-migrations.mjs` 确认版本序列为 1..11。
3. `frontend/src/utils/nodeMetrics.ts:21` `sumMetrics()` 零参数会走 `[].reduce` 抛 TypeError
   （当前无零参调用点，纯防御性）。
4. `agent/main.go:1836` 把 `cores` 初值由 1 改为 0（上游语义）：若 `cpu.Counts(true)` 在个别平台失败，
   CPU 规格会从「1 核」变为缺省不显示。知情即可。
5. `mergeMemorySnapshot` 删掉了 fork 原有的「`swapTotal > ramTotal*4` → 清零」启发式
   （上游 `TestAuditSwapRespectsCgroupBeforeHostProc` 明确反对按 RAM 比例否决 swap）。
   副作用：少数把宿主机 swap 镜像进 cgroup 的 LXC，现在会显示大 swap 而不是 0/—。
   建议上线后抽查 1–2 台 LXC 节点的 swap 面板。
6. 迁移 11 的 `cfm_load_metric_window_stats` 把 ram/disk 的 `else 0` 改成「算不出来即排除样本」
   （`where metric_value is not null`）。与「不可用≠0」一致，但会改变负载告警的 `samples` 分母
   （`ram_total=0` 的样本不再当 0% 计入），阈值统计口径有变化。
7. `toPublicReport` 现在把 `cpu_capacity` 与 `metric_errors` 放进公开快照
   （匿名 `/api/live/clients` 可见），会暴露容器 CPU 配额与「容器作用域不可用」判定。
   与上游一致；私有 fork 若在意，可改为仅登录态返回。

## 实际执行过的核查

### 边界（是否夹带非 B3 改动）

- `grep -rn verboseLogf agent/` → 0 命中；`agent/logging.go` 不存在；`logReport` 仍是 `log.Printf`
  （`agent/main.go:3269`），GPU / WebSocket 日志仍用 `log.Printf`。
- 与 `6ddadff:agent/main.go` 逐段对照：差异**只**在 logging（`verboseLogf`/log-file/verbose 旗标）、
  `redactURLSecret`/`normalizeServerURL`/`requestErrorWithoutURL` 这些 fork 自有实现；
  B3 逻辑与上游逐字相同。
- `grep ClientSyncChange|next_cursor_key|device_ordinal worker/src/db/types.ts` → 0 命中；
  `types.ts` 只改 `MonitorRecord` 9 个字段的可空性。
- `NodeTable.tsx`：`MiniPingChart` 仍是静态 import，全文件无 `lazy`/`Suspense`
  （`App.tsx`/`Index.tsx` 的 lazy 是既有代码，未动）。
- 新增 Go 文件 `metric_availability.go`/`memory_scope.go`/`cgroup_cpu.go`/`audit_*.go`
  与上游逐字相同（忽略 CRLF 后 `diff` 完全一致）。

### 迁移

- `generated/supabase-migrations.ts` 版本序列 → `1,2,3,4,5,6,7,8,9,11`，顺序正确。
- `11_metric_availability.sql` 与上游 `8_metric_availability.sql` **逐字节相同**。
- 10 条迁移的 sha256 与 generated 内 checksum 全部一致（bad=0）。
- `grep -rln "cfm_insert_monitor_record|cfm_load_metric_window_stats"` → 仅 `4_rpc_api.sql` 与 `11`；
  迁移 6–9 未改过这两个函数，不存在被静默覆盖的 fork 修复。`4` 里 `load` 的「显式 null 特判」
  被 `11` 的 `case when input_record ? 'load' then ... else 0 end` 等价覆盖，未丢语义。
- pglite 直连建库成功（本身即证明自然排序生效）；`information_schema` 查证 9 列 `is_nullable=YES`。
- 直连调用 `cfm_insert_monitor_record`：`{cpu:null,ram:null,swap:null,load:null}` → 落库全 null；
  `{}` 缺字段 → 全 0；`cfm_load_metric_window_stats` 对该 client `samples=1`（null 样本被排除）。

### 自审真实性

- `go build ./...` EXIT=0；`go vet ./...` EXIT=0；`go test -count=1 ./...` → `ok ... 32.267s`
  （自审写 31.548s，机器抖动）。
- worker `tsc --noEmit` EXIT=0；`node --test` → **531 / 531 pass / 0 fail**。
- frontend `tsc -b` EXIT=0；`node --test` → **150 / 150 pass / 0 fail**；
  `test/metric-availability.audit.test.mjs` 单跑 24/24；`test/audit-metric-availability-runtime.test.mjs`
  单跑 1/1（7.5s，真实 pglite）。
- VERIFICATION 行号抽查全部对得上：`main.go:170–177`（指针无 `omitempty`）、`3086–3090`（网络不可用早退）、
  `3151–3153`（恢复时 `delete(MetricErrors,"network")`）、`main_test.go:1006–1012`（拼入
  `metric_availability.go`）；声称的 4 个 Go 用例名都真实存在。

### 语义

- 上游 `agent/audit_swap_scope_test.go:32-48` 确实断言
  `unavailable container swap must remain unavailable instead of borrowing host totals`
  →「清零假装 0」改为「标记不可用」有上游依据。
- `grep swap_total|hasSwap` 全仓：前端只剩 DetailsGrid/NodeTable 展示（已改 `=== undefined` 判定，
  null 显示 `—`）、`ClientInfo` 的元数据总容量（另一概念）、类型放宽；无遗漏的「swap 当 0」假设。
- `publicHistory.ts:66-117` 不变量成立：`nullableNumberField`（null→保留、undefined/非有限数→丢整行），
  9 个指标逐个判 undefined；`process_count/connections/connections_udp` 仍走 `numberField`+`allNumbers`，未被放松。
- `grep mergeHistoryRecords|historyCursorFromRecord|next_cursor_key` → 0 命中；前端审计测试与上游差异
  **只有**删掉 `id` 断言那 2 行（已披露），无其它 id 依赖。

### 判别力反向验证（回退 → 跑 → 恢复，4 组）

| 回退点 | 测试 | 结果 |
|---|---|---|
| worker `toMonitorRecord` 的 `cpu: report.cpu` → `report.cpu \|\| 0` | monitor-report.metric-availability.audit | **12 pass / 1 fail**（cpu 那条） |
| worker `toPublicReport` 删掉 `Object.assign(result, selectMetricAvailability(...))` | 同上 | **11 pass / 2 fail** |
| frontend `nullableNumberField` 的 `null → null` 改成 `null → undefined`（退回丢整行） | publicHistory.load-unavailable + 前端审计 | **15 pass / 10 fail** |
| frontend `buildMonitorChartData` 的 `cpu: cpu===null ? null` 改成 `? 0` | 前端审计 | **23 pass / 1 fail**（缺失缺口用例） |

每组回退都立刻变红 → 测试有判别力，不是恒真。恢复后复跑：worker 13/13、frontend 25/25 全绿；
`git status` 仍为 37 行、`git diff --name-only` 与审查开始时一致，实验未留残留。

### 测试是否被削弱

- 4 个 Go 测试改动全是机械类型适配（`CPU: float64Metric(17)` 等），断言保留原值
  （如 `*report.NetOut != 40`），无 `ok(x!==undefined)` 之类放松。
- `publicHistory.load-unavailable.test.mjs` 由「cpu null 应丢整行」改为「保留行且 cpu=null」+
  新增「cpu 字符串仍丢整行」，属于加强。
- `website-migration.reaudit.test.mjs` 的 `applied===9 → BUNDLED_SUPABASE_MIGRATIONS.length`
  与上游逐字相同，非本地自选放松。
- 两个新增 worker 审计测试与上游逐字相同。

## 未复核项

- 未跑 `wrangler types --check` / `wrangler deploy --dry-run`，未对真实 Supabase 执行迁移
  （`notify pgrst, 'reload schema'` 的真实 PG 行为未验）。
- 未跑 `vite build`（只跑 `tsc -b`，未验证 Vite 对 `./format.ts`、`./nodeMetrics.ts` 带扩展名导入的实际打包）。
- 未在真实 LXC / lxcfs / 受限 cgroup 主机上验证 `procFileIsLXCFS`、`readCgroupCPU`、swap 不可用判定，
  仅 fixture 与单测层面。
- 未做真实 Windows 服务安装/升级冒烟；未在真实 CF Durable Object 上验证冷启动持久化
  （runtime 测试走 miniflare + pglite）。
- 未跑 `frontend/browser/*.mjs` 浏览器审计脚本（上游该文件未移植）。
- 未验证「老 Agent（缺字段）→ 服务端按 0 存」的**端到端**路径，只分层验证了
  `normalizeMonitorReport` 与 SQL 函数。

## §6 Post-PASS 增量复核（rev2）

**触发原因**：上节「非阻断建议 #1」指出自审开头把未跟踪的 `11_metric_availability.sql` 算进了
`git diff` 的 35 文件统计，措辞不准确。主代理据此只改了 `VERIFICATION.md` 开头一段（未动任何代码）。

**rev2 审议方**：另一位独立 `general-purpose` 子代理（与前一轮审议员不同的实例），范围限定为该处措辞。

### 核查与结论

1. **数字核对**：`git diff --stat HEAD -- . ':!VERIFICATION.md' ':!REVIEW.md'`
   → `35 files changed, 1353 insertions(+), 293 deletions(-)`，与新表述「已跟踪文件 35 个 / +1353 / −293」
   逐字吻合。全量 `git diff --stat HEAD` → `37 files changed, 1565 insertions(+), 451 deletions(-)`，
   37 = 35 + 2，反证「不含两个文档」的括注必要且正确。
2. **未跟踪迁移核对**：`git status --porcelain | grep '^??'` 仅一行
   `?? supabase/migrations/11_metric_availability.sql`（4480 字节，盘上确实存在）。
   「`git commit -am` 会漏掉它」成立——`-a` 只覆盖已跟踪文件的修改。
3. **开头段其余引用**：`git log --oneline -1 a092297` 确为 B1+B2 提交；`git stash list` 的
   `stash@{0}` 描述与自审一致（8 个文件）。rev2 指出一处**轻微不精确**：`10_cf_tunnel_domains.sql`
   实际未出现在 `git stash show --name-only stash@{0}` 列表中（它在 stash 的未跟踪部分），
   自审把它写进 stash 括注属列举不精确，不构成事实错误，不影响结论。
4. **「差异只改了开头一段」的方法论说明**：`git diff -- VERIFICATION.md` 无法证明这一点——
   HEAD 里的 VERIFICATION.md 仍是 B1+B2 版（blob `31b91d5`），B3 稿从未进过 index 或 commit，
   git 只能给出「整份重写」。改用两组替代证据：
   - **时间戳隔离**：`find . -newer VERIFICATION.md` 为空，即该文件是全仓最新；最近的源码改动是
     `worker/src/utils/monitor-report.ts`（16:43:50），rev2 这一步（17:00:04）之后无任何源码被写。
   - **正文引用抽查**：`main.go:170-177`（裸指针 + omitempty 组合）、`main.go:3086`（网络不可用早退）、
     `main.go:3152`（`delete(MetricErrors,"network")`）、`main_test.go:1006-1012`（拼入
     `metric_availability.go`）行号全部未位移，表格结论未被波及。

**rev2 结论**：`PASS`。新表述与实测一致，未引入新的不准确之处，也未波及正文结论、数字或表格行。
rev2 建议保留该写法。

### rev2 非阻断观察

- 自审「仅属于 B3 的改动」严格说包含 `scripts/generate-migrations.mjs` 等 4 处自然排序修复，
  那是 B3 暴露出的独立缺陷修复，VERIFICATION 第二节已如实交代，措辞可接受。
- `REVIEW.md` 同为相对 HEAD 的整份重写且未提交，属 rev1 审议员写入，不涉及本次措辞修正。

