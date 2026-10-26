# cf-vps-monitor 本地验证环境（Docker）

> ⚠️ **仅用于本地端到端验证，不是生产部署。**
> 生产目标始终是 Cloudflare Workers + 托管 Supabase（见仓库根 `DEPLOY.md`）。
> 这里用 `postgres + postgrest + nginx` 在本地复刻 Supabase 的 **Kong → PostgREST** 路由，
> 让你在**不依赖托管 Supabase 账号**的情况下验证 cf-vps-monitor 的数据层与 Worker HTTP 层。

## 拓扑
```
nginx(:8455)  →  剥离 /rest/v1 前缀  →  postgrest(:3000)  →  postgres(:5432, db: cfmonitor)
```
Worker 代码里拼接的是 `${SUPABASE_URL}/rest/v1/rpc/<fn>`，
因此本环境把 `SUPABASE_URL` 设为 `http://localhost:8455`，由 nginx 还原成 PostgREST 的 `/rpc/<fn>`，
与 Supabase 线上完全一致。

## 启动
```bash
cd docker/validate
docker compose up -d --build
```

## 应用迁移
迁移脚本在 `../supabase/migrations/`（已挂载进 db 容器）：
```bash
docker compose exec -T db sh -c 'for f in 1_core_schema 2_security_access 3_feature_schema 4_rpc_api 5_runtime_defaults 6_site_monitor; do psql -U postgres -d cfmonitor -v ON_ERROR_STOP=1 -f /migrations/$f.sql || exit 1; done'
docker compose exec -T db psql -U postgres -d cfmonitor -f /post-migrate.sql
```

## 生成 service_role JWT（给 Worker 当 SUPABASE_SECRET_KEY）
```bash
node gen-jwt.mjs
```

## 跑 Worker 对接本地 PostgREST
在仓库根 `worker/.dev.vars` 追加（或新建一个本地验证用的 env）：
```
SUPABASE_URL=http://localhost:8455
SUPABASE_SECRET_KEY=<上面生成的 JWT>
JWT_SECRET=<任意 32+ 字符随机串>
```
然后：
```bash
cd worker
NO_PROXY=localhost,127.0.0.1 npx wrangler dev --local --var SUPABASE_URL=http://localhost:8455 --var SUPABASE_SECRET_KEY=<JWT> --var JWT_SECRET=<串>
```
（wrangler dev 会同时托管前端静态资源与 /api 路由。）

## 验证 admin 登录与会话
上一步的 Worker 跑起来后，另开一个终端：
```bash
node docker/validate/verify-login.mjs
```
它依次打 `POST /api/login`、`GET /api/me`、`GET /api/admin/clients`
（**后两个仅在登录成功、拿到 cookie 时才请求**，否则直接打印 `SKIPPED`），
逐行打印 `HTTP <状态码>`、`setCookie=yes|no`，以及响应里出现的 `username` /
`code` / 客户端条数（`clients=N`）。**不输出密码、token、cookie 的明文内容**。

脚本把 `BASE` 硬编码为 `http://127.0.0.1:8787`，即 `wrangler dev` 的默认端口；
如果你用 `--port` 改了端口，需同步改脚本里的 `BASE`，否则会静默连到别处或连不上。

> 该脚本**不是单元测试**，请不要把它改名成 `test-*.mjs` 或 `*.test.mjs`，
> 也不要挪进任何名为 `test/` 的目录：根级 `npm test` 是裸跑 `node --test`，
> 它会按内置规则递归收录 `test-*.js`、`*.test.js`、`**/test/**/*.js` 等文件；
> 一旦被收录，CI 会因为 `127.0.0.1:8787` 连不上而以 ECONNREFUSED 判红。

## 清理
```bash
docker compose down -v   # 连同数据卷一起删除
```
