<!-- reviewed-by: independent-subagent -->

# 独立审议 (REVIEW) — 上游精选移植 B1+B2

- 审查对象工作树：`E:/工作站/cf-vps-monitor-src`（分支 `main`，HEAD `3f89905`，改动全部未提交）
- 审查方式：只读复核 + 独立重跑 + 对上游对象（`69bbda4`、`7f63112..6ddadff`）逐行比对
- 审查范围：B1（Windows 停止竞态）/ B2（健康恢复）/ 新增测试与夹具 / `VERIFICATION.md`。CF Tunnel WIP 按要求完全排除，未做任何读取性判断。

## 审议结论

**PASS**（阻断项 0 个）

三项实质校验均独立通过：改动与上游语义一致（B1 一行、B2 两处删除）；新增测试具备真实判别力（我用 HEAD 旧代码反向跑夹具，`exited-after-enumeration` 由 `stopped:true` 变为 `stopped:false / ObjectNotFound`，证明用例不是空跑）；健康恢复/节流/读失败三条语义在代码与实测上都能闭环。发现的 7 项均为低/中等级证据或过程问题，不阻断入库。

## 交付物清单

| # | 文件 | 状态 | 实际改动量 | 与上游关系 |
|---|---|---|---|---|
| 1 | `agent/install-windows.ps1` | M | 1 行（`494`） | 与 `69bbda4` 逐字相同 |
| 2 | `agent/install-windows-safety.test.mjs` | M | +21 / -0 | 与 `69bbda4` 新增块逐字相同（仅保留本仓库既有的 `t.diagnostic`，属既有差异） |
| 3 | `agent/testdata/windows-process-stop.ps1` | ??? 未跟踪 | 新增 59 行 | 与 `69bbda4` 版本 `diff` 为空（完全一致） |
| 4 | `worker/src/utils/observability.ts` | M | -11 / +0 | 与 `7f63112..6ddadff` 的缓存删除两部分一致；有意未取 `cron_client_sync` 一行 |
| 5 | `worker/src/utils/observability-health-recovery.test.mjs` | ??? 未跟踪 | 新增 117 行 | 本仓库自写（上游无此文件） |
| 6 | `VERIFICATION.md` | M | 自审文档 | 复核见下节 |

`git diff --stat` 实测：`install-windows-safety.test.mjs +21`、`install-windows.ps1 1 line`、`observability.ts -11`，与自审描述一致。

## 独立重跑结果

未采信主代理结果，全部命令由我重跑。

**1) 三文件合并回归**

```
"C:/Users/sfkj/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" --test \
  worker/src/utils/observability.test.mjs \
  worker/src/utils/observability-health-recovery.test.mjs \
  agent/install-windows-safety.test.mjs
```
→ `# tests 30 / # pass 30 / # fail 0 / # skipped 0`，EXIT=0，duration ≈ 79.2s。

**2) 单独确认 Windows 夹具真跑（排除 skip 假绿）**

```
node --test --test-reporter=tap agent/install-windows-safety.test.mjs
```
→ `ok 13 - CI02 ... running` / `ok 14 - ... exited-after-enumeration` / `ok 15 - ... stop-denied` / `ok 16 - ... stop-failed`，`# pass 16 / # fail 0 / # skipped 0`。4 个场景确实执行，非 skip。

**3) 单独重跑健康恢复用例**

```
node --test --test-reporter=tap worker/src/utils/observability-health-recovery.test.mjs
```
→ 5 个用例全 `ok`（same instance / another instance / repeated success throttle / missing database / read failure），`# pass 5 / # fail 0 / # skipped 0`，EXIT=0。

**4) Worker 类型检查**

```
"C:/.../node.exe" worker/node_modules/typescript/bin/tsc --noEmit -p worker/tsconfig.json
```
→ 无输出，EXIT=0。

**5) 补跑主代理遗漏的关联测试（我额外加的）**

```
node --test --test-reporter=tap worker/src/utils/observability-health-components.test.mjs \
  worker/src/utils/webhook-business.reaudit.test.mjs
```
→ 无 `not ok`，EXIT=0（前者直接 import `observability.ts` 并断言组件注册表，属本次改动的邻接面）。

**6) 判别力实验（关键，主代理未做）**：把 `HEAD:agent/install-windows.ps1`（仍为 `Stop-Process -Id`）取到临时目录，用同一夹具反向跑：

| 场景 | 旧代码（`-Id`） | 新代码（`-InputObject`） |
|---|---|---|
| running | stopped=true / null | stopped=true / null |
| exited-after-enumeration | **stopped=false / ObjectNotFound** | stopped=true / null |
| stop-denied | stopped=false / PermissionDenied | stopped=false / PermissionDenied |
| stop-failed | stopped=false / InvalidOperation | stopped=false / InvalidOperation |

说明：`exited-after-enumeration` 用例在旧代码下必然失败 ⇒ 该用例真实约束本次修复，不是自我实现式空跑。

**7) 宿主版本补充验证（我额外加的）**：README:139 以 `.\install-windows.ps1` 直接调用，宿主可能是 Windows PowerShell 5.1。用 `powershell.exe`(5.1) 跑同一夹具：`running` 与 `exited-after-enumeration` 均为 `stopped:true / exited:true / failureCategory:null`。即修复在 5.1 与 pwsh 7 下语义一致，无版本相关回归。

## 交叉审视发现

| 序号 | 严重度 | 问题 | 建议 | 是否阻断 |
|---|---|---|---|---|
| 1 | 中 | **两个交付文件仍处于未跟踪状态**：`git status --short` 显示 `?? agent/testdata/windows-process-stop.ps1`、`?? worker/src/utils/observability-health-recovery.test.mjs`。若按习惯 `git commit -am`，二者不会入库，CI 上 `install-windows-safety.test.mjs` 会因夹具 ENOENT 直接红，B2 则完全没有测试。 | 提交时显式 `git add` 这 5 个文件；提交后用 `git show --stat HEAD` 核对文件数=5。 | 否（代码本身无缺陷，属提交前置条件） |
| 2 | 低 | **自审遗漏邻接测试**：`worker/src/utils/observability-health-components.test.mjs` 也 import `observability.ts`，VERIFICATION 第 5 项「三文件合并回归」未包含它，却在文中声称「合并回归 30/30」。 | 自审证据里补上该文件（我已补跑，EXIT=0，无回归）。 | 否 |
| 3 | 低 | **自审对新用例数量记错**：`observability-health-recovery.test.mjs` 实为 **5** 个 `test()`（`observability-health-recovery.test.mjs:48` 的 `for` 生成 2 个，`74/89/99` 各 1 个），VERIFICATION 第 4 项写成「14/14（含 4 个新用例）」。总数 14 恰好对（`observability.test.mjs` 9 + 新文件 5），但拆分描述失真。 | 改成「9 + 5 = 14」。 | 否 |
| 4 | 低 | **B1 的证据强度不足以支撑结论**：VERIFICATION 第 1 项用 `grep` 证明「规避 PID 复用竞态」，grep 只能证明文本存在。真正的机理是：`Get-AgentInstanceProcesses` 返回 `Get-Process` 对象（`install-windows.ps1:486`），对象已持有进程句柄，`Stop-Process -InputObject`（`install-windows.ps1:494`）走 `Process.Kill()` 按句柄终止，不再按 PID 二次解析，因此 PID 复用窗口被消除；`$process.WaitForExit(15000)`（`install-windows.ps1:495`）作用于同一对象仍有效（`running` 场景 stopped/exited 双 true 即其证据）。 | 自审改用「机理 + 旧代码反向对照」作为证据（见本文「重跑结果 6」）。 | 否 |
| 5 | 低 | **读放大（非写放大）已发生**：删除进程内缓存后，每次 `ok` 都会先 `db.getSetting`（`observability.ts:147`）。节流窗口内旧实现 0 次读，现在每次调用 1 次读。量化：`worker/wrangler.toml:18` 为 `*/2`，`index.ts:998-1006` 7 个步骤按 `rotateScheduledItems` 轮转，粗估 +20~30 次读/小时；`notification-dispatch.ts:197/232/275` 每次发送 +1 读。Durable Object 热路径不受影响（`live-data.ts:2648-2650` 自带 `healthOkLastWriteAt` 1h 闸门，先短路再调用）。写放大仍被 DB `last_success_at` 正确约束（测试 3 实测 writes=1）。 | 属正确性换成本，可接受；但在免费 CPU 预算语境下建议上线后看一次 D1/RPC 读量，勿把「CPU 预算」当成已同时解决。 | 否 |
| 6 | 低 | **error→success 在并发下不是绝对「一定」恢复**：`observability.ts:147` 读、`:163` 写是 read-modify-write，无 CAS。若成功写入与一个更早读到的错误写入交错，仍可能以旧值覆盖新值。上游同源，非本次引入，也不因删缓存而恶化（删缓存反而缩小了「进程内缓存长期压制恢复」的窗口）。 | 保持现状；如需强一致再评估条件更新 RPC。 | 否 |
| 7 | 低 | **枚举阶段仍有窄竞态（上游同样未处理）**：`Get-AgentInstanceProcesses` 在 `install-windows.ps1:486-488` 用 `$_.Path` 过滤，若进程恰在枚举与取 `Path` 之间退出，`MainModule` 取值可能抛异常而中断安装。B1 只覆盖了 stop 阶段，「停止竞态已修复」不宜理解为「枚举竞态也已修复」。上游 `69bbda4` 未处理此项，故不算移植缺陷。 | 若后续要彻底收口，可对 `$_.Path` 做 try/catch 跳过已退出项。 | 否（无法独立验证：本机沙箱禁止我启动外部进程实测 `.MainModule` 退出后行为，仅有 .NET 语义推断） |
| 8 | 低 | **上游同提交的 `agent/main_test.go`（22 行，纯测试侧）未移植**，VERIFICATION 只写「未跑 Go 测试」，未说明这是有意取舍。该改动只影响非 Windows 下 `TestExecuteICMPPingUsesResolvedPublicIP` 的假 ping/ping6 与 PATH 设置，无生产代码含义。 | 在自审里补一句「main_test.go 为测试侧修正，本次不取」。 | 否 |

## 对自审(VERIFICATION.md)的复核

| 自审条目 | 复核结论 | 依据 |
|---|---|---|
| 1 Windows 停止改用进程对象 | **成立，但原证据偏弱** | 行号 `install-windows.ps1:494` 复现；语义由「重跑结果 6」的旧/新对照 + 句柄机理确认 |
| 2 4 个停止场景夹具可执行 16/16 | **成立** | 独立重跑 16/16，`# skipped 0`，CI02 四例逐一 `ok` |
| 3 成功节流缓存已彻底移除 | **成立** | `grep -rn healthSuccessThrottleCache worker/src agent` → 0 命中 |
| 4 健康恢复 14/14 | **总数成立，拆分失实** | 实为 9（既有）+ 5（新增）= 14；新增是 5 例不是 4 例（见发现 3） |
| 5 三文件合并回归 30/30 | **成立，但不完整** | 30/30 复现；漏了 `observability-health-components.test.mjs`（见发现 2，已补跑通过） |
| 6 tsc EXIT=0 无输出 | **成立** | 复跑 EXIT=0、无输出 |
| 7 改动范围未含 CF WIP | **成立** | `git status --short` 逐项比对，B1+B2 恰为 5 个文件；`observability.test.mjs` 未被改动（重要：既有断言未被削弱） |
| 未验证项①真实 Windows 服务升级未实测 | **如实，且表述恰当** | 我同样未做；但补了 PS 5.1 宿主验证，缩小了该缺口 |
| 未验证项②未跑全量 JS 套件 | **如实** | 我未跑全量（95 个测试文件，且会混入 CF WIP 噪声）；已补跑两个直接关联文件，均绿 |
| 未验证项③未跑 Go | **如实** | 本次无 `.go` 改动，可不跑；但应说明 `main_test.go` 的取舍（发现 8） |
| 未验证项④未做 wrangler dry-run | **如实** | 本次不涉配置/迁移 |
| 未验证项⑤未验证真实 DO 并发 | **如实** | 单测用两个 loader 实例模拟；`createWorkerLoader`（`worker/test-support/worker-module.mjs:12`）为每次调用新建 vm context + 独立模块缓存，实例隔离是真实的，但共享 DB 不等于真实 DO 并发 |
| 遗漏风险：读放大 | **缺失** | 自审未提「删缓存后每次都读」的成本（见发现 5） |
| 遗漏风险：未跟踪文件 | **缺失** | 自审未提示两个新文件尚未 `git add`（见发现 1） |
| `cron_client_sync` 故意不引入的理由 | **成立** | `grep -rn cron_client_sync worker/src` → 0 命中（仓库内无写入点）；`observability.test.mjs:167` 断言注册表长度 21、`:194-195` 断言无孤儿组件，强行加入确会红 |

## 独立意见

1. **B1 判定：真实修复，且是我认为唯一正确的写法。** 关键不在于「换了参数」，而在于终止动作从「按 PID 二次查找」变成「按已持有句柄执行」，这句改动同时把「已退出」从异常降级为无操作——`exited-after-enumeration` 由 `ObjectNotFound` 变为成功，正是这一点的实测体现。`WaitForExit` 仍针对同一对象，未失效（`running` 场景 stopped/exited 双 true 可证），`-ErrorAction Stop` 仍在，`stop-denied`/`stop-failed` 仍 fail-closed，安全边界没有被放松。

2. **B2 判定：语义正确，写放大真的被 DB 约束住了。** 节流条件为 `status==='ok' && previous.status==='ok' && last_success_at`（`observability.ts:148`），因此：错误之后的成功不受节流（实测 reads/writes 各 +1、`status` 立即回 `ok`、`last_failure_at` 保留）；同状态重复成功仍被 DB 时间戳压住（实测跨 3 次调用 writes 恒为 1）；读失败时 `getSetting` 抛出、未触及 `setSetting`（实测 writes 不增、持久化内容不变、`bestEffort` 只记一条 console.error 且不冒充成功）。四点与自审描述一致。

3. **测试不是假绿。** 这是我最花力气验证的一项：新增的 4 个 Windows 用例在旧代码下有一例必然失败，说明它们绑定了真实缺陷；B2 的 5 个用例全部打真实 PGlite + 真实 `cfm_settings_by_keys`/`cfm_set_settings`，并对读/写次数做了差分断言（`observability-health-recovery.test.mjs:67-68,81,85,110`），能同时抓住「恢复被压制」和「写放大回归」两个方向。唯一的形式瑕疵是 `stop-denied`/`stop-failed` 用 `Stop-Process` 函数覆写注入错误，属于对 cmdlet 的替换而非真实权限失败，但这是唯一可控的做法，且断言的是错误类别透传，可接受。

4. **过程风险大于代码风险。** 唯一有实际后果的是发现 1：两个核心文件还没被 git 跟踪。代码本身我给 PASS，但提交动作必须显式 `git add` 这 5 个文件，否则「测试通过」这件事在 CI 上不成立。

5. **建议后续（不阻断）**：把邻接测试纳入常规回归集合；上线后观察一次 D1/RPC 读量以确认删除缓存没有把 CPU 预算吃回去；若要彻底收口停止竞态，再处理 `install-windows.ps1:486-488` 的枚举侧 `Path` 读取。
