# VERIFICATION — Docker 端到端验证（cf-vps-monitor）

- **日期**：2026-09-23
- **触发**：boss 指令「你先在docker部署，检查没问题在部署Cloudflare」
- **范围**：在不依赖托管 Supabase 的前提下，用本地容器复刻 Supabase 的 REST/RPC 面，端到端验证数据层 + Worker HTTP 层 + 鉴权链路；并实测 Cloudflare 部署所需的两个前置条件。
- **结论**：**Docker 端到端验证 PASS**；**Cloudflare 部署被两个外部前置条件阻塞（非代码问题）**。

---

## 1. 验证拓扑

Worker 的 DB provider 硬编码为 `supabase-api`（`worker/src/db/provider.ts:5,30-32`，`resolveDatabaseProvider` 忽略 env 恒返回 `supabase-api`），其客户端调用 `${SUPABASE_URL}/rest/v1/rpc/<fn>`（PostgREST）。因此本地用三容器复刻同一路径形状：

| 组件 | 镜像 | 作用 |
|---|---|---|
| db | `postgres:15-alpine` | 真库；`:5445→5432` |
| postgrest | `postgrest/postgrest:v12.2.0` | 提供 REST/RPC 面 |
| proxy | `nginx:alpine` | 剥离 `/rest/v1` 前缀转发（模拟 Supabase 的 Kong 路由）；`:8455→80` |

编排文件：`docker/validate/docker-compose.yml`（+ `init.sql` / `nginx.conf` / `post-migrate.sql`）。
`SUPABASE_URL=http://localhost:8455` 时，真实 Worker 走的路径与生产完全一致。

---

## 2. 实测证据

| # | 检查项 | 命令/手法 | 结果 |
|---|---|---|---|
| 1 | 迁移落库 | 6 个迁移 + `post-migrate.sql` 依序应用 | **21 张表 + 135 个 `cfm_*` 函数**建成 |
| 2 | 读 RPC | `cfm_public_settings` / `cfm_public_clients`（经 nginx:8455） | 返回完整 settings map / `[]` |
| 3 | 写 RPC | `cfm_create_user` | `true` |
| 4 | Worker 启动 | `wrangler dev --local --port 8787` | 绑定全部加载；`GET /ping` → `pong` |
| 5 | F7 公开状态页 | `GET /api/public/status` | 200，真实 DB 数据 |
| 6 | 登录 | `POST /api/login`（admin / 已知口令） | **200，下发会话 cookie** |
| 7 | 会话校验 | `GET /api/me`（带 cookie） | **200，`username=admin`** |
| 8 | 鉴权后台 | `GET /api/admin/clients`（带 cookie） | **200**（admin 鉴权中间件 + DB 查询全通） |
| 9 | 部署就绪度 | `npm run verify:cloudflare`（dry-run） | **409 个静态资源 + Worker，989.39 KiB / gzip 193.34 KiB** ✅ |

Worker 运行日志（节选，无 error）：
```
[wrangler:info] GET /api/public/status 200 OK
[wrangler:info] POST /api/login        200 OK
[wrangler:info] GET  /api/me           200 OK
[wrangler:info] GET  /api/admin/clients 200 OK
```

---

## 3. 过程中修复的坑

1. **迁移挂载路径错**：`../supabase/migrations` 被解析为 `docker/supabase/...` → 改 `../../supabase/migrations`。
2. **迁移 4 `role "anon" does not exist`**：`supabase/migrations/4_rpc_api.sql:2816` 有未加保护的 `revoke ... from anon/authenticated`。解法：在 `init.sql` 建 `anon`/`authenticated`（忠实 Supabase；**不改生产迁移文件**）。
3. **`wrangler --var` 语法**：必须 `--var KEY:VALUE`（冒号）；等号形式静默丢弃变量，表现为 Worker 报 "Database is not ready"。
4. **登录口令**：密码算法为 `pbkdf2_sha256$10000$<b64 salt>$<b64 hash>`（`worker/src/auth/password.ts`）。原测试用户存的是占位 bcrypt → 恒登录失败；用 `crypto.pbkdf2Sync` 造合法哈希后 UPDATE 即通。

---

## 4. Cloudflare 部署阻塞项（均实测）

### 阻塞 ①：CF Token 缺 `Workers Scripts:Edit`

```
GET /user/tokens/verify                    → 200（token active）
GET  /accounts/{acc}/workers/scripts        → 200（有 Read）
PUT  /accounts/{acc}/workers/scripts/<tmp>  → 403 "No access to the specified resource."  ← 无 Edit
```
无 `Edit` 则无法上传 Worker → **任何部署路径都走不通**。
处置：CF Token 权限**创建后不可编辑**，必须重新生成并勾选 **Account · Workers Scripts · Edit**。

### 阻塞 ②：无真实 Supabase 项目

- `wrangler.toml` 的 `SUPABASE_URL` 仍为 `PROJECT_REF` 占位；全仓无真实 `*.supabase.co`。
- `scripts/deploy-cloudflare.mjs:74-96`：fresh deploy 遇占位直接 `fail`；且 URL 必须匹配**严格正则** `^https://[a-z0-9-]+\.supabase\.co/?$` → 隧道/自定义域名会被拒。
- `scripts/deploy-cloudflare.mjs:139-161`：非 dry-run 需已存在 `JWT_SECRET` + `SUPABASE_SECRET_KEY` 两个 secret。
- 结论：**真实 Supabase 项目实质必需**。

---

## 5. 待 boss 提供

1. 重新生成的 **CF API Token**（勾选 `Account · Workers Scripts · Edit`；其余按 `DEPLOY.md`：`Zone:Read` + `Zone Settings:Edit` + `Cache Purge:Purge` + `Account · Cloudflare Pages:Read`）。
2. **Supabase 项目**的 `SUPABASE_URL` + `service_role` key（免费档即可；迁移按 `DEPLOY.md` 1.1 执行）。

齐备后一键上线：
```bash
cd worker
npx wrangler secret put JWT_SECRET           # ≥32 字节随机串
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY
npm run deploy                                # 根目录
```
随后访问 `/db-init` 或登录页创建管理员账号。

---

_本记录为 Docker 验证里程碑的自审证据（门禁第 2 关）。生成方式：全部为实测命令输出，无推断填充。_
