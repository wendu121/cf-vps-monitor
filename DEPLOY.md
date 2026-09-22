# 部署与运维指南（site-monitor 能力移植版）

> 目标：把 `E:\工作站\cf-vps-monitor-src`（cf-vps-monitor + site-monitor 移植功能）部署到
> **Cloudflare Workers + Supabase**，并装上 Go Agent 二进制监控家里小主机 / Docker 宿主。
> **全程无 Docker。**

---

## 0. 已代拍板的决策（boss 可推翻，均为部署层参数）

| 项 | 取值 | 说明 |
|---|---|---|
| **D1 · CF Workers 档位** | **$5/月 付费档** | 免费档 CPU 10ms/请求、subrequest 50/请求会限制资产同步与诊断；付费档买确定性。降级只需在 CF 后台改，代码零改动 |
| **D6 · Supabase** | **新建免费项目** | 免费档 500MB；Cron 每 2 分钟请求会保活，不会因闲置 pause |
| **D2 · 多区域共识** | 原生 Agent 节点（`agent_probe_mode`） | 不移植远程代理端点 |
| **D5 · 旧 site-monitor** | 一次性迁移后下线 | 无双跑、`data_host/` 留 30 天备份 |

---

## 1. 前置准备

### 1.1 Supabase（对应 D6）

1. 在 [supabase.com](https://supabase.com) 新建项目（免费档即可），记下：
   - `SUPABASE_URL`（Project URL）
   - `SUPABASE_SECRET_KEY`（**service_role key**，不是 anon key）
2. 执行迁移（二选一）：
   - **Dashboard**：SQL Editor 中按顺序执行 `supabase/migrations/1_core_schema.sql` → `5_runtime_defaults.sql` → **`6_site_monitor.sql`**（本次新增）
   - **CLI**：`supabase db push`
3. 迁移 6 会新增/扩展：
   - `website_monitors`：`source` / `cf_project_name` / `cf_zone_id`
   - `website_checks`：`ssl_days_left`
   - 新表：`cf_sync_runs`、`cf_domains`、`notification_queue`
   - 新 RPC：`cfm_cf_domains` / `cfm_cf_sync_runs` / `cfm_sync_cf_domains` / `cfm_insert_cf_sync_run` / `cfm_website_sla_report` / `cfm_website_consensus` / `cfm_notification_pending` / `cfm_notification_queue` / `cfm_enqueue_notification` / `cfm_ack_notifications` / `cfm_expire_notifications`

### 1.2 Cloudflare（对应 D1）

1. Workers 升级到 **$5/月 付费档**（Workers Paid）。
2. 创建 **CF API Token**（自定义 Token，非 Global API Key），权限：
   | Group | Resource | Access |
   |---|---|---|
   | Account | Cloudflare Pages | Read |
   | Account | Workers Scripts | **Edit**（含列举 + 回滚） |
   | Zone | Zone | Read |
   | Zone | **Zone Settings** | **Edit**（开发模式 + SSL 设置） |
   | Zone | Cache Purge | Purge |
   | Zone | Analytics | Read（可选） |

   > ⚠️ **坑（已实测）**：`Zone`（管 DNS 等 zone 资源）与 `Zone Settings`（管开发模式/SSL 设置）是
   > **两个不同资源**。只给 `Zone:Edit` 时，读写 `development_mode` 仍会返回 9109/10000。
   > 另外：CF Token 创建后权限**不可编辑**，要加权限必须重新生成（密钥串不变）。

---

## 2. 部署 Worker

```bash
cd worker

# 1) 登录并配置密钥（不要写进 wrangler.toml）
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SECRET_KEY

# 2) 部署（会同时上传前端静态资源）
npm run deploy
```

部署完成后，系统会引导创建管理员账号（或访问 `/db-init`）。

### 2.1 关键环境变量 / 设置项

| 名称 | 位置 | 说明 |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | Worker Secret | 数据库连接 |
| `cf_api_token` / `cf_account_id` | **Supabase `settings` 表** | CF 凭据（RLS 保护，仅 admin RPC 可读）；本地开发用 git-ignored 的 `worker/.dev.vars` |
| `cf_sync_interval_min` | settings | CF 资产同步间隔（默认 30，0 = 关闭） |
| `agent_mail_relay` | settings | 设为 `false` 关闭 agent-mail 中继入队（默认开启） |
| `agent_mail_expire_hours` | settings | 未确认告警自动超时小时数（默认 24） |

---

## 3. 安装 Go Agent（被监控端 · 二进制，无 Docker）

1. Fork `aixmbcom/cf-vps-monitor` 到自己的 GitHub。
2. 在 fork 仓库跑 GitHub Actions 的 **「Agent Release」** workflow —— 它会生成指向**你自己仓库**的安装脚本与二进制（否则安装脚本会指向上游仓库）。
3. 在目标机器（家里小主机 / VPS / Docker 宿主）执行生成的安装命令，例如：
   ```bash
   curl -fsSL https://raw.githubusercontent.com/<你的用户名>/cf-vps-monitor/main/scripts/install.sh | bash
   ```
   - root：装到系统目录 + systemd 保活
   - 非 root：装到用户目录 + crontab `@reboot` 保活
4. 在管理后台「服务器」页生成 Token 与安装命令，粘贴到被监控机。

> Agent 主动 WebSocket 出站连接 → NAT/家庭网络友好，无需公网 IP、无需端口映射。
> 装在 **Docker 宿主机**上即得整机指标 + 容器感知；装在**闲置小主机**上即得整机监控。
> ⚠️ **单容器维度不支持**（Agent 无 per-container 指标，需另接 cAdvisor）。

---

## 4. 功能与页面对照

| 功能 | 后端路由 | 前端页面 |
|---|---|---|
| F1 CF 资产同步 | `POST /api/admin/cf/sync` + Cron `cron_cf_sync` | `/admin/cf` |
| F2 CF 一键运维 | `POST /api/admin/cf/zone/:id/purge`、`/dev-mode`（GET 回显 + POST 设置）、`POST /worker/:name/rollback` | `/admin/cf` |
| F3 域名 + SSL 清单 | `GET /api/admin/cf/domains`、`/sync-runs` | `/admin/cf`（含 CSV 导出） |
| F4 SLA 月报 | `GET /api/admin/ops/sla?month=YYYY-MM` | `/admin/sla` |
| F5 深度诊断 | `GET /api/admin/ops/websites/:id/diagnose` | `/admin/diagnose` |
| F6 多区域共识 | `GET /api/admin/ops/websites/:id/consensus?window=30` | 经 API 提供（站点详情可接入） |
| F7 公开状态页 | `GET /api/public/status`（免鉴权） | `/status` |
| F8 agent-mail 中继 | `GET /api/admin/ops/notifications/pending`、`POST /ack`、`/enqueue`、`GET /notifications` | `/admin/agent-mail` |

---

## 5. F8 与 WorkBuddy 自动化对接

自动化配置在 WorkBuddy 侧（不在本仓库），把拉取地址改为：

```
GET  https://<你的 worker 域名>/api/admin/ops/notifications/pending?limit=50
POST https://<你的 worker 域名>/api/admin/ops/notifications/ack     body: {"ids":[1,2,3]}
```

拉取需 admin 会话（Cookie + `X-CSRF-Token`）。建议：自动化先登录拿会话，或为本用途增设一个只读 Token
（如需，可在 `routes/ops.ts` 增加 Bearer 鉴权分支）。超过 `agent_mail_expire_hours` 未 ack 的条目
会由 Cron 自动标记超时，防止堆积。

---

## 6. P7 · 从旧 site-monitor 迁移（一次性）

```bash
# 先 dry-run，确认解析数量
SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
SITE_MONITOR_DATA=E:/工作站/site-monitor/data_host \
node scripts/migrate-site-monitor.mjs --dry-run

# 确认无误后写入
node scripts/migrate-site-monitor.mjs --sample=100
```

实测 dry-run 结果：**12 站点 / 46815 条检测 / 500 条事件**。
迁移后用「SLA 月报」页核对同月可用率，一致即可停用旧 site-monitor，
并把 `data_host/` 压缩备份保留 30 天。

---

## 7. 本地开发

```bash
cd E:/工作站/cf-vps-monitor-src
npm ci
npm run build:migrations          # 生成 worker/src/generated/supabase-migrations.ts
cd worker && npx wrangler types   # fresh clone 必须先跑一次，否则 lint 报 types out of date
npm run lint                      # 类型检查
cd .. && npm --prefix frontend run build
```

CF 凭据放 `worker/.dev.vars`（已被 git 忽略，**切勿提交**）：

```
CF_API_TOKEN=xxxx
CF_ACCOUNT_ID=xxxx
```
