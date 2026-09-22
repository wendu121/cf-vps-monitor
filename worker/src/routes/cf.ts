/**
 * CF 资产 / 域名 / 一键运维 路由（F1/F2/F3）
 *
 * 挂载于 /api/admin/cf（由 index.ts 的 /api/admin/* 中间件做 JWT + CSRF 鉴权）。
 *
 * 凭据：resolveCfCredentials(env, settings) 双路径——开发期走 worker/.dev.vars，
 *       生产期走 Supabase settings 表（cf_api_token / cf_account_id）。绝不进代码。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { CloudflareApi, resolveCfCredentials } from '../utils/cf-client';
import { syncCfAssets } from '../utils/cf-sync';
import { getDatabase } from '../db/provider';
import { errorDetail } from '../utils/observability';

const cfRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
type CfContext = Context<{ Bindings: Bindings; Variables: Variables }>;

async function requireCredentials(c: CfContext): Promise<{ api: CloudflareApi } | { error: Response }> {
  const database = getDatabase(c.env);
  // 生产期经 settings 表取用（仅 admin RPC 可读），开发期 env 注入优先；两者皆无则未配置。
  const settingsMap = await db.getSettingsByKeys(database, ['cf_api_token', 'cf_account_id']);
  const creds = resolveCfCredentials(c.env, settingsMap);
  if (!creds) {
    return { error: c.json({ configured: false, error: 'CF 凭据未配置（请在设置中填写 cf_api_token / cf_account_id，或本地 .dev.vars）' }, 200) };
  }
  return { api: new CloudflareApi(creds) };
}

// 实时拉取 CF 资产（zones / workers / pages），不写库。
cfRoutes.get('/assets', async (c) => {
  const creds = await requireCredentials(c);
  if ('error' in creds) return creds.error;
  const api = creds.api;
  try {
    const [zones, workers, pages, customDomains] = await Promise.all([
      api.listZones(),
      api.listWorkers(),
      api.listPages(),
      api.getProjectCustomDomains(),
    ]);
    if (!zones.configured) {
      return c.json({ configured: false, error: 'Cloudflare API 未配置或鉴权失败' }, 200);
    }
    return c.json({
      configured: true,
      zones: zones.items,
      workers: workers.items.map(w => ({ id: w.id, name: w.name, url: w.url })),
      pages: pages.items.map(p => ({ id: p.id, name: p.name, subdomain: p.subdomain, url: p.url, domains: p.domains })),
      customDomains,
      noPermission: Boolean(zones.noPermission || workers.noPermission),
      error: zones.error || workers.error || pages.error,
    });
  } catch (e) {
    return c.json({ configured: true, error: errorDetail(e) }, 502);
  }
});

// 已落库的域名清单（F3 展示用）。
cfRoutes.get('/domains', async (c) => {
  const database = getDatabase(c.env);
  return c.json(await db.listCfDomains(database));
});

// 同步运行记录（最近若干次）。
cfRoutes.get('/sync-runs', async (c) => {
  const database = getDatabase(c.env);
  const runs = await db.listCfSyncRuns(database);
  return c.json(runs.slice(0, 50));
});

// 触发一次资产 + 域名同步（F1/F3）：单事务落库 cf_domains，并记录运行日志。
cfRoutes.post('/sync', async (c) => {
  const creds = await requireCredentials(c);
  if ('error' in creds) return creds.error;
  const api = creds.api;
  const database = getDatabase(c.env);
  try {
    // 单事务同步 + 聚合（逻辑与 Cron 共用，见 utils/cf-sync.ts）
    const summary = await syncCfAssets(database, api);
    const runId = await db.insertCfSyncRun(database, { kind: 'domains', new_count: summary.domains, skipped_count: 0, error: null });
    await db.insertAuditLog(database, c.get('username')!, 'cf_sync', `CF 域名同步完成: domains=${summary.domains}; zones=${summary.zones}; workers=${summary.workers}; pages=${summary.pages}; run=${runId}`);
    return c.json({ ok: true, ...summary });
  } catch (e) {
    const detail = errorDetail(e);
    await db.insertCfSyncRun(database, { kind: 'domains', new_count: 0, skipped_count: 0, error: detail }).catch(() => undefined);
    return c.json({ ok: false, error: detail }, 502);
  }
});

// F2 一键运维 —— 清缓存（zone 级）。
cfRoutes.post('/zone/:zoneId/purge', async (c) => {
  const creds = await requireCredentials(c);
  if ('error' in creds) return creds.error;
  const api = creds.api;
  const zoneId = c.req.param('zoneId');
  const database = getDatabase(c.env);
  const res = await api.purgeCache(zoneId);
  if (!res.ok) {
    await db.insertAuditLog(database, c.get('username')!, 'cf_purge', `清缓存失败: zone=${zoneId}; ${res.error}`, 'warning');
    return c.json({ ok: false, reason: res.reason, error: res.error }, res.reason === 'permission' ? 403 : 502);
  }
  await db.insertAuditLog(database, c.get('username')!, 'cf_purge', `清缓存成功: zone=${zoneId}`);
  return c.json({ ok: true });
});

// F2 一键运维 —— 开发模式开关（zone 级 setting，需 Zone Settings:Edit）。
cfRoutes.post('/zone/:zoneId/dev-mode', async (c) => {
  const creds = await requireCredentials(c);
  if ('error' in creds) return creds.error;
  const api = creds.api;
  const zoneId = c.req.param('zoneId');
  const database = getDatabase(c.env);
  let on = false;
  try {
    const body = await c.req.json().catch(() => ({}));
    on = Boolean(body && (body as { on?: boolean }).on);
  } catch {
    on = false;
  }
  const res = await api.setDevMode(zoneId, on);
  if (!res.ok) {
    await db.insertAuditLog(database, c.get('username')!, 'cf_dev_mode', `开发模式${on ? '开' : '关'}失败: zone=${zoneId}; ${res.error}`, 'warning');
    return c.json({ ok: false, reason: res.reason, error: res.error }, res.reason === 'permission' ? 403 : 502);
  }
  await db.insertAuditLog(database, c.get('username')!, 'cf_dev_mode', `开发模式${on ? '开' : '关'}成功: zone=${zoneId}`);
  return c.json({ ok: true, value: res.value });
});

// F2 一键运维 —— 读取开发模式当前状态（前端 Switch 初始回显）。
cfRoutes.get('/zone/:zoneId/dev-mode', async (c) => {
  const creds = await requireCredentials(c);
  if ('error' in creds) return creds.error;
  const api = creds.api;
  const zoneId = c.req.param('zoneId');
  const res = await api.getDevMode(zoneId);
  if (!res.ok) {
    // 权限不足（缺 Zone Settings:Read/Edit）时返回结构化错误，前端据此显示「未知」。
    return c.json({ ok: false, reason: res.reason, error: res.error }, res.reason === 'permission' ? 403 : 502);
  }
  return c.json({ ok: true, enabled: res.enabled });
});

// F2 一键运维 —— Worker 版本回滚（account 级，需 Workers Scripts:Edit）。
cfRoutes.post('/worker/:name/rollback', async (c) => {
  const creds = await requireCredentials(c);
  if ('error' in creds) return creds.error;
  const api = creds.api;
  const name = c.req.param('name');
  const database = getDatabase(c.env);
  const res = await api.rollbackWorker(name);
  if (!res.ok) {
    await db.insertAuditLog(database, c.get('username')!, 'cf_rollback', `Worker 回滚失败: script=${name}; reason=${res.reason}; ${res.error || ''}`, 'warning');
    return c.json({ ok: false, reason: res.reason, error: res.error }, res.reason === 'permission' ? 403 : 502);
  }
  await db.insertAuditLog(database, c.get('username')!, 'cf_rollback', `Worker 回滚成功: script=${name}; rolled_to=${res.rolled_to}`);
  return c.json({ ok: true, rolled_to: res.rolled_to });
});

export { cfRoutes };
