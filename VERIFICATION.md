# VERIFICATION — 交付前自审（cf-vps-monitor · Docker 端到端验证交付）

- **项目根**：`E:\工作站\cf-vps-monitor-src`（git 仓库，HEAD=`2fa9577`）
- **本会话时间**：2026-09-23
- **交付摘要**：按 boss 指令「先在 docker 部署，检查没问题再部署 Cloudflare」，新增一套本地容器验证编排，端到端验证数据层 + Worker HTTP 层 + 鉴权链路；并实测 Cloudflare 部署的两个前置条件。**未改动任何生产代码**（`worker/src`、`frontend/src`、`supabase/migrations` 零改动）。
- **详细证据**：同目录 `VERIFICATION_docker_validation.md`。

## 一、本次交付物清单（全部为新增，未修改既有文件）

| 文件 | 性质 | 说明 |
|---|---|---|
| `docker/validate/docker-compose.yml` | 新增 | postgres + postgrest + nginx 三容器编排 |
| `docker/validate/init.sql` | 新增 | 建 `anon`/`authenticated`/`service_role`/`authenticator` 角色 + pgcrypto |
| `docker/validate/nginx.conf` | 新增 | 剥离 `/rest/v1` 前缀（模拟 Kong 路由） |
| `docker/validate/post-migrate.sql` | 新增 | 迁移后补授权（幂等兜底） |
| `docker/validate/gen-jwt.mjs` | 新增 | 自签 service_role JWT（与 PGRST_JWT_SECRET 一致） |
| `docker/validate/seed-admin.sql` | 新增 | 写入已知口令的合法 pbkdf2 哈希供登录测试 |
| `docker/validate/test-login.mjs` | 新增 | 登录/会话/后台接口冒烟（不打印口令与 token） |
| `docker/validate/README.md` | 新增 | 编排拓扑与用法 |
| `VERIFICATION_docker_validation.md` | 新增 | 验证证据详录 |

`git status --short` 实证：仅 `?? VERIFICATION_docker_validation.md`、`?? docker/`（无 modified 既有文件）。

## 二、已验证项（命令 + 实测结果）

| # | 断言 | 证据 |
|---|---|---|
| 1 | 数据层建成 | 6 迁移 + post-migrate 依序应用 → **21 表 + 135 个 `cfm_*` 函数**（psql 查询计数） |
| 2 | 读 RPC 通 | `cfm_public_settings` 返回完整 settings map；`cfm_public_clients` 返回 `[]`（经 nginx:8455） |
| 3 | 写 RPC 通 | `cfm_create_user` → `true` |
| 4 | Worker 可起 | `wrangler dev --local --port 8787`；绑定全部加载；`GET /ping` → `pong` |
| 5 | F7 通 | `GET /api/public/status` → 200，返回真实 DB 数据 |
| 6 | 登录通 | `POST /api/login`（admin/已知口令）→ 200 且下发会话 cookie |
| 7 | 会话校验通 | `GET /api/me`（带 cookie）→ 200 `username=admin` |
| 8 | admin 鉴权通 | `GET /api/admin/clients`（带 cookie）→ 200 |
| 9 | 部署就绪 | `npm run verify:cloudflare` dry-run → 409 资源 / 989.39 KiB（gzip 193.34 KiB） |
| 10 | Token 无 Edit | `PUT /accounts/{acc}/workers/scripts/<一次性>` → **403 No access**（verify 200 / list 200） |
| 11 | 无真实 Supabase | 全仓 grep `https://*.supabase.co` 零命中；`wrangler.toml` 仍为 `PROJECT_REF` 占位 |

## 三、未验证项（明确标注，未以推断冒充结论）

1. **未在真实 Cloudflare 部署**——缺 `Workers Scripts:Edit` Token（实测 403），且无真实 Supabase 项目。故「能跑起来」仅在本地点验证成立，线上未证。
2. **未在任何 Supabase 实例上跑迁移**——本轮迁移只跑在本地 `postgres:15-alpine`。托管 Supabase 的差异（内置角色、扩展、RLS 执行环境）未实测。
3. **F1/F2/F3/F4/F5/F6/F8 未做端到端验证**——这些依赖真实 CF 凭据（zone/worker/pages）与真实站点数据，本地无。本轮只验证到「路由挂载 + 公共接口 + 鉴权中间件」层面。
4. **Agent（Go）未测**——本机无 Go 工具链，`npm test` 会失败，故未跑。
5. **本地编排非生产**——`docker/validate/` 仅用于验证，含硬编码本地口令与本地 JWT 密钥，不得用于生产（README 已声明）。

## 四、信息源与置信度

- 全部结论来自本轮**实测命令输出**（curl/node fetch/psql/wrangler/docker compose），非文档推断。
- 高置信：验证项 1–9、11。
- 中置信：验证项 10（单一测试路径，但 403 语义明确、可重复）。
- 低置信/未证：未验证项 1–5。

## 五、已知风险

- 本地 harness 的 nginx 剥前缀行为与真实 Supabase Kong 路由**形状一致但实现不同**；极端路径（如 RPC 重载、大 payload、RLS 边界）未覆盖。
- `init.sql` 建 `anon`/`authenticated` 是为让未加保护的 `revoke`（`4_rpc_api.sql:2816`）在本地不报错；真实 Supabase 已内置这两角色，**不影响生产迁移语义**。

## 六、Blockers 更新（2026-09-23 11:0x，boss 提供新 Token 后复测）

> 本节为对第二节第 10 项的**增量更新**：阻塞①原判定基于**旧的** `.dev.vars` Token，boss 已新建 Token 并交付，现复测如下。

新 Token 落于 `worker/.dev.vars`（`.gitignore:16` 已忽略，`git grep` 确认未进入任何被跟踪文件）。**全量权限实测**：

| 能力 | 结果 |
|---|---|
| `GET /user/tokens/verify` | **200**（active） |
| `Account · Workers Scripts · Read`（list scripts） | **200** |
| **`Account · Workers Scripts · Edit`（PUT 一次性脚本后 DELETE）** | **200 / 200** ✅ |
| `Zone · Zone · Read`（list zones） | **200** |
| `Account · Cloudflare Pages · Read`（list projects） | **200** |
| `Zone · Zone Settings · Read`（development_mode / ssl） | **200** |
| `Zone · Zone Settings · Edit`（dev_mode 用当前值幂等写回） | **200** |
| `Zone · DNS · Read`（list dns_records） | **200** |
| `Zone · Cache Purge · Purge`（只 purge 不存在的假文件，未伤真实缓存） | **200** |
| `Zone · Analytics · Read`（REST dashboard） | **404 / code 1015**：Zone Analytics REST API 已下线、改用 GraphQL —— **非权限拒绝**；该项本为可选，无功能依赖 |

**结论**：**阻塞①（缺 `Workers Scripts:Edit`）已解除**，部署能力已具备；F1/F2/F3 所需权限（Zone:Read / Zone Settings:Edit / Cache Purge:Purge / Pages:Read）全部实测可用。**阻塞②（无真实 Supabase 项目）仍然存在**，部署脚本 `scripts/deploy-cloudflare.mjs:74-96` 会因 `PROJECT_REF` 占位直接 fail —— 待 boss 交付 `SUPABASE_URL` + `service_role` key。

写操作安全声明：本轮唯一写操作 = 「上传后立即删除的一次性脚本」+「purge 一个不存在的假文件」+「development_mode 用当前值原样写回」，均未改变任何线上真实状态。
