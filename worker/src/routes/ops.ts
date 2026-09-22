/**
 * 运维增强路由（F4 SLA 月报 / F5 深度诊断 / F6 多区域共识 / F8 agent-mail 中继）
 *
 * 挂载于 /api/admin/ops（由 index.ts 的 /api/admin/* 中间件做 JWT + CSRF 鉴权）。
 * 对外语义兼容 site-monitor 的 /api/report/sla、/api/diagnose/:id、/api/alerts/pending、/api/alerts/ack。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { getDatabase } from '../db/provider';
import { errorDetail } from '../utils/observability';
import { diagnoseSite } from '../utils/diagnose';
import { computeConsensus, CONSENSUS_MIN } from '../utils/consensus';

const opsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
type OpsContext = Context<{ Bindings: Bindings; Variables: Variables }>;

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function parseMonth(value: string | undefined): string {
  if (!value) return currentMonth();
  return /^\d{4}-\d{2}$/.test(value) ? value : currentMonth();
}

function parseId(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// F4 · SLA 月报：GET /api/admin/ops/sla?month=YYYY-MM
opsRoutes.get('/sla', async (c: OpsContext) => {
  const database = getDatabase(c.env);
  const month = parseMonth(c.req.query('month'));
  try {
    const rows = await db.getSlaReport(database, month);
    return c.json({ month, rows });
  } catch (e) {
    return c.json({ month, rows: [], error: errorDetail(e) }, 502);
  }
});

// ---------------------------------------------------------------------------
// F6 · 多区域共识：GET /api/admin/ops/websites/:id/consensus?window=30
// 按 Agent 节点（website_checks.source_client）多数表决，阈值 CONSENSUS_MIN=0.5。
opsRoutes.get('/websites/:id/consensus', async (c: OpsContext) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const windowRaw = Number(c.req.query('window') || 30);
  const windowMinutes = Number.isFinite(windowRaw) ? Math.min(Math.max(Math.trunc(windowRaw), 1), 1440) : 30;
  const database = getDatabase(c.env);
  try {
    const raw = await db.getWebsiteConsensus(database, id, windowMinutes);
    const consensus = computeConsensus((raw as { nodes?: unknown }).nodes, CONSENSUS_MIN);
    return c.json({
      monitor_id: id,
      window_minutes: windowMinutes,
      consensus_min: consensus.consensus_min,
      node_count: consensus.node_count,
      up_nodes: consensus.up_nodes,
      consensus_ratio: consensus.consensus_ratio,
      consensus_status: consensus.consensus_status,
      nodes: consensus.nodes,
    });
  } catch (e) {
    return c.json({ monitor_id: id, error: errorDetail(e) }, 502);
  }
});

// ---------------------------------------------------------------------------
// F5 · 深度诊断：GET /api/admin/ops/websites/:id/diagnose
// DoH DNS 解析 + HTTP 探测 + 分级 reason_code + 中文建议。
opsRoutes.get('/websites/:id/diagnose', async (c: OpsContext) => {
  const id = parseId(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);
  const database = getDatabase(c.env);
  const monitor = await db.getWebsiteMonitor(database, id);
  if (!monitor) return c.json({ error: 'monitor_not_found' }, 404);

  try {
    const result = await diagnoseSite({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      method: monitor.method,
      timeout_sec: monitor.timeout_sec,
      expected_status_min: monitor.expected_status_min,
      expected_status_max: monitor.expected_status_max,
    });
    await db.insertAuditLog(
      database,
      c.get('username')!,
      'website_diagnose',
      `站点诊断: ${monitor.name} → ${result.reason_code}`,
      result.reason_code === 'ok' ? 'info' : 'warning'
    );
    return c.json(result);
  } catch (e) {
    return c.json({ monitor_id: id, error: errorDetail(e) }, 502);
  }
});

// ---------------------------------------------------------------------------
// F8 · agent-mail 中继：待投递队列（WorkBuddy 自动化拉取）
// 语义兼容 site-monitor 的 GET /api/alerts/pending
opsRoutes.get('/notifications/pending', async (c: OpsContext) => {
  const database = getDatabase(c.env);
  const limitRaw = Number(c.req.query('limit') || 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
  try {
    const items = await db.listPendingNotifications(database, limit);
    return c.json(items);
  } catch (e) {
    return c.json({ items: [], error: errorDetail(e) }, 502);
  }
});

// 队列全量（管理 UI 用，含已投递）
opsRoutes.get('/notifications', async (c: OpsContext) => {
  const database = getDatabase(c.env);
  const limitRaw = Number(c.req.query('limit') || 100);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 100;
  try {
    return c.json(await db.listNotificationQueue(database, limit));
  } catch (e) {
    return c.json({ items: [], error: errorDetail(e) }, 502);
  }
});

// 语义兼容 site-monitor 的 POST /api/alerts/ack，body: { ids: number[] }
opsRoutes.post('/notifications/ack', async (c: OpsContext) => {
  const database = getDatabase(c.env);
  let ids: number[] = [];
  try {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    if (Array.isArray(body?.ids)) {
      ids = body.ids
        .map(v => Number(v))
        .filter(v => Number.isInteger(v) && v > 0);
    }
  } catch {
    ids = [];
  }
  if (ids.length === 0) return c.json({ ok: false, error: 'no_ids' }, 400);
  try {
    const affected = await db.ackNotifications(database, ids);
    return c.json({ ok: true, acked: affected });
  } catch (e) {
    return c.json({ ok: false, error: errorDetail(e) }, 502);
  }
});

// 手动入队（供测试/外部系统投递告警）
opsRoutes.post('/notifications/enqueue', async (c: OpsContext) => {
  const database = getDatabase(c.env);
  let body: { channel?: string; subject?: string; body?: string; payload?: Record<string, unknown> } = {};
  try {
    body = (await c.req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }
  const subject = String(body.subject || '').trim();
  const content = String(body.body || '').trim();
  if (!subject || !content) return c.json({ ok: false, error: 'subject_and_body_required' }, 400);
  const channel =
    body.channel === 'telegram' || body.channel === 'email' || body.channel === 'webhook'
      ? body.channel
      : 'agent_mail';
  try {
    const id = await db.enqueueNotification(database, {
      channel,
      subject,
      body: content,
      payload: body.payload ?? null,
    });
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ ok: false, error: errorDetail(e) }, 502);
  }
});

export { opsRoutes };
