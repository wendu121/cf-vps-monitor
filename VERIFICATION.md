# 交付前自审 (VERIFICATION) — CI Lint 修复（wrangler types --check 口径不一致）

> 本轮只改 **1 个文件**：`.github/workflows/ci.yml`，`+26` 行 = **16 行注释 + 1 个 step**
> （9 行正文 + 1 个空行），无删除。
> 上一轮（B3，commit `63ac544`）的 VERIFICATION/REVIEW 已被本文件取代，
> 原文可从 `git show 63ac544:VERIFICATION.md` / `git show 63ac544:REVIEW.md` 取回。
>
> **不在本轮范围**：boss 的 CF Tunnel WIP（8 个已修改文件 + 2 个未跟踪文件）仍未提交，
> 本次只暂存 `ci.yml` 与两份门禁文档。

## 问题

`63ac544` 推送本身**没有**产生 workflow run（该 fork 的 Actions 此前处于关闭状态，
已由 `gh workflow enable ci.yml` 打开）。打开后在 `63ac544` 之上做的一次探测提交
`55a297d0` 触发了首次 run；该 ref 上 `.github/workflows/ci.yml` 的 blob 为
`ad620e803b7e`，与本轮修复前的 HEAD blob 相同，因此其失败结论对本轮完全适用：
**第一步 Lint 就失败**。

```
✘ [ERROR] Types at worker-configuration.d.ts are out of date.
           Run `wrangler types` to regenerate.
```

## 根因（三方对照实测，非推断）

`worker/package.json` 的 `lint` 是 `wrangler types --check && tsc --noEmit`。
`wrangler types` 会把 `worker/.dev.vars` 里的**每一个键**折进生成的 `Env` 接口，
而 `.dev.vars` 被 `.gitignore`（第 17 行 `.dev.vars*`）排除，CI 里根本不存在。

| 环境 | `wrangler types` 生成的键 | 与已提交的 `worker-configuration.d.ts` 比 |
|---|---|---|
| CI（无 `.dev.vars`） | 仅 1 个 `SUPABASE_URL: "https://PROJECT_REF.supabase.co"`（来自 wrangler.toml `[vars]`） | ❌ 不一致 |
| boss 本机（`.dev.vars` 6 键，多一个 `SUPABASE_ACCESS_TOKEN`） | 6 个，均为 `string` | ❌ 不一致 |
| 恰好那 5 键的占位 `.dev.vars` | 5 个，均为 `string` | ✅ 重新生成后 md5 == HEAD blob `50efcfc…`；`--check` 输出 `up to date` |

结论：已提交的声明文件是按「5 个绑定」生成的，既不符合 CI 也不符合本地，
**它在 CI 里从来没有通过过**。这是既有缺陷，与 B3 无关——B3 未触碰
`wrangler.toml` / `worker-configuration.d.ts`，且在本轮修复前的本地 HEAD 上
`npm run lint` 同样失败。

## 修法

在 `Lint` 步骤**之前**加一步 `Seed CI env bindings`，用 heredoc 写入**只有键名、
值为占位符**的 `worker/.dev.vars`（5 个键）。CI 的生成口径即与已提交的声明文件对齐，
且不引入任何真实密钥；boss 本地开发体验不受影响（不需要动他真实的 `.dev.vars`）。

同时在注释里写死两条防回归约束（由独立审议提出，已在 rev2 前补上）：

1. **`SUPABASE_URL` 必须留在种子里**——它会遮蔽 `wrangler.toml` `[vars]` 的字面量，
   一旦被「清理」掉，生成类型会退回 `"https://PROJECT_REF.supabase.co"` 字面量，`--check` 立刻红；
2. **只有键集生效、与值无关**，但增删键必须同步重新生成 `worker-configuration.d.ts`；
   并注明 wrangler 4.116.0 没有跳过 `.dev.vars` 的开关（`--env-file` 只能追加文件），
   免得后人再去找这条路。

## 一、已验证项 (Verified)

| # | 结论 | 验证命令 / 依据（实证） | 结果 |
|---|---|---|---|
| 1 | CI 此前确实因该原因失败 | `gh run view 40299541754 --repo wendu121/cf-vps-monitor --log-failed` | 失败步骤 = `Lint`，报 `Types at worker-configuration.d.ts are out of date` |
| 2 | 失败与 B3 无关 | 在 `63ac544`（未含本轮修复）的本地工作区跑 `cd worker && npm run lint` | 同样报 out of date → 既有缺陷 |
| 3 | 无 `.dev.vars` 时生成物缺 5 键 | 临时移走 `.dev.vars` 后 `npx wrangler types` + `diff` | 生成物只剩 `SUPABASE_URL: "https://PROJECT_REF.supabase.co"` |
| 4 | 6 键时多出 `SUPABASE_ACCESS_TOKEN` | 用真实 `.dev.vars` 生成后 `diff` | 多出 `SUPABASE_ACCESS_TOKEN: string` |
| 5 | 5 键占位时生成物与 HEAD 完全一致 | 占位 `.dev.vars` → `npx wrangler types` → `md5sum` | md5 `50efcfc878c63f7674ed1be57954f7e4` == `git show HEAD:worker/worker-configuration.d.ts` 的 md5 |
| 6 | 修复后整链 lint 通过 | 模拟 CI：写入同样的 5 键占位 `.dev.vars` + 该文件取 index 的 LF 版本 → `npm run lint`（根目录，含 frontend `tsc` 与 worker `wrangler types --check && tsc`） | `✨ Types at worker-configuration.d.ts are up to date.`，**EXIT=0** |
| 7 | YAML 结构正确（heredoc 缩进会被正确剥离） | `awk` 打印 44–62 行并 `cat -A` 核对列位 | `run: \|` 在列 8，脚本内容统一列 10 → YAML 剥离后 heredoc 内容与结束符 `EOF` 均在第 0 列，shell 可正确解析 |
| 8 | 改动范围只有 1 个文件 | `git status --short` / `git diff --stat` | 仅 `.github/workflows/ci.yml`（+ 两份门禁文档） |

## 二、未验证项 (Unverified)

- **未在 GitHub 上真实验证该修复**：本地是「模拟 CI」通过，真正结论要等推送后
  `CI` 工作流跑完。**这一步必须做**，否则不能宣布修复完成。
- **未验证后续步骤**：`npm run build`（含 vite build 与 `build:migrations`）、`npm test`
  （`node --test` 全仓 + `go test`）、以及 security/权限相关步骤在 CI 上是否通过，
  均未实测。若 Lint 通过后仍有其它步骤失败，属新信息，需另起一轮。
- **未改 `worker-configuration.d.ts` 本身**：本轮选择「让 CI 口径向已提交文件对齐」，
  而非「重新生成并提交」。若 boss 之后增删 `.dev.vars` 的键，这个文件会再次漂移。
- **本地 Windows 的 `npm run lint` 仍会失败**：`core.autocrlf=true` 让工作区是 CRLF，
  而 `wrangler types --check` 按字节比；且 boss 的 `.dev.vars` 仍有第 6 个键
  `SUPABASE_ACCESS_TOKEN`。这属于本地开发体验问题，**不在本轮修复目标内**（CI 用 LF 检出）。

## 三、信息源与置信度

- CI 失败日志：`gh run view --log-failed` 实测输出，**置信度高**。
- 根因链：三组对照实验（无/.6 键/5 键）+ md5 比对，**置信度高**。
- 「CI 修复是否真的生效」：**尚未验证，置信度 0**，须等真实 CI 运行结果。
