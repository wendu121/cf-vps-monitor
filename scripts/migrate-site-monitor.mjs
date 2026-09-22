#!/usr/bin/env node
/**
 * P7 · 一次性数据迁移：site-monitor（本地 JSON） → cf-vps-monitor（Supabase）
 *
 * 用法：
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SECRET_KEY=<service_role_key> \
 *   SITE_MONITOR_DATA=E:/工作站/site-monitor/data_host \
 *   node scripts/migrate-site-monitor.mjs [--dry-run] [--sample=100]
 *
 * 依赖：Supabase 必须已 apply 全部迁移（含 6_site_monitor.sql），
 *       即 website_monitors / website_checks / audit_logs 及新增列均已存在。
 *
 * 迁移映射（见 DESIGN.md 第 7 节）：
 *   sites.json   → website_monitors（name/url 直接映射；zone_id→cf_zone_id；source='manual'）
 *   checks.json  → website_checks（ts→checked_at；status→status_code；ok/latency_ms 直接映射）
 *   events.json  → audit_logs（down/up → website_alert / website_recovery）
 *
 * 策略：一次性 + 抽样校验，无双写、无并行运行。
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const DATA_DIR = process.env.SITE_MONITOR_DATA || '';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const sampleArg = args.find(a => a.startsWith('--sample='));
const SAMPLE_SIZE = sampleArg ? Number(sampleArg.split('=')[1]) || 100 : 100;

function die(message) {
  console.error(`\n[FATAL] ${message}\n`);
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  die('缺少 SUPABASE_URL / SUPABASE_SECRET_KEY 环境变量。');
}
if (!DATA_DIR || !existsSync(DATA_DIR)) {
  die(`SITE_MONITOR_DATA 目录不存在：${DATA_DIR || '(未设置)'}`);
}

async function readJson(file) {
  const full = path.join(DATA_DIR, file);
  if (!existsSync(full)) {
    console.warn(`[skip] 未找到 ${file}`);
    return null;
  }
  try {
    return JSON.parse(await readFile(full, 'utf8'));
  } catch (error) {
    console.warn(`[warn] ${file} 解析失败：${error.message}`);
    return null;
  }
}

/** 调用 Supabase RPC（与 worker 的 callSupabaseRpc 同约定）。 */
async function rpc(name, params = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${name} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

async function main() {
  console.log('=== site-monitor → cf-vps-monitor 一次性迁移 ===');
  console.log(`数据源：${DATA_DIR}`);
  console.log(`模式：${DRY_RUN ? 'DRY-RUN（只解析不写入）' : '写入'}\n`);

  const files = await readdir(DATA_DIR).catch(() => []);
  console.log(`目录内文件：${files.join(', ') || '(空)'}\n`);

  const sites = await readJson('sites.json');
  const checks = await readJson('checks.json');
  const events = await readJson('events.json');

  const siteList = Array.isArray(sites) ? sites : (sites && Array.isArray(sites.sites) ? sites.sites : []);
  const checkList = Array.isArray(checks) ? checks : (checks && Array.isArray(checks.checks) ? checks.checks : []);
  const eventList = Array.isArray(events) ? events : (events && Array.isArray(events.events) ? events.events : []);

  console.log(`解析结果：sites=${siteList.length} checks=${checkList.length} events=${eventList.length}`);

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] 前 5 个站点预览：');
    for (const s of siteList.slice(0, 5)) {
      console.log(`  - ${s.name} ${s.url} (zone=${s.zone_id || '-'})`);
    }
    console.log('\n[DRY-RUN] 未写入任何数据。');
    return;
  }

  // -------------------------------------------------------------------------
  // 1) sites.json → website_monitors
  // -------------------------------------------------------------------------
  let created = 0;
  let skipped = 0;
  const idMap = new Map(); // site-monitor 的 id → 新 monitor id

  for (const site of siteList) {
    const name = String(site.name || '').trim();
    const url = String(site.url || '').trim();
    if (!name || !url) {
      skipped += 1;
      continue;
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        skipped += 1;
        continue;
      }
    } catch {
      skipped += 1;
      continue;
    }

    // 注：cfm_create_website_monitor 只写入核心列；source 取表默认值 'manual'（正是迁移数据所需），
    //     cf_zone_id 不由此 RPC 写入（源数据 zone 多为 '-'，无影响）。
    const payload = {
      name,
      url,
      method: site.method === 'HEAD' ? 'HEAD' : 'GET',
      expected_status_min: clampInt(site.expected_status_min, 100, 599, 200),
      expected_status_max: clampInt(site.expected_status_max, 100, 599, 399),
      interval_sec: clampInt(site.interval_sec, 60, 86400, 300),
      timeout_sec: clampInt(site.timeout_sec, 1, 30, 10),
      grace_period_sec: clampInt(site.grace_period_sec, 30, 86400, 180),
      enabled: site.enabled === undefined ? true : Boolean(site.enabled),
      hidden: Boolean(site.hidden),
      hide_url: false,
    };

    try {
      const row = await rpc('cfm_create_website_monitor', { input_monitor: payload });
      // RPC 返回 to_jsonb(created_row)；取不到整数 id 时明确报错，避免后续 check 静默跳过。
      const rawId = row && typeof row === 'object' ? row.id : row;
      const newId = Number(rawId);
      if (!Number.isInteger(newId) || newId <= 0) {
        throw new Error(`返回 id 无效：${JSON.stringify(row).slice(0, 120)}`);
      }
      idMap.set(site.id ?? site.name, newId);
      created += 1;
    } catch (error) {
      console.warn(`[warn] 站点「${name}」写入失败：${error.message}`);
      skipped += 1;
    }
  }
  console.log(`\nwebsite_monitors：成功 ${created}，跳过 ${skipped}`);

  // -------------------------------------------------------------------------
  // 2) checks.json → website_checks
  // -------------------------------------------------------------------------
  let checkInserted = 0;
  for (const check of checkList) {
    const monitorId = idMap.get(check.site_id ?? check.monitor_id);
    if (!monitorId) continue;
    try {
      await rpc('cfm_record_website_check', {
        input_check: {
          monitor_id: monitorId,
          checked_at: toIso(check.ts || check.checked_at),
          ok: Boolean(check.ok),
          effective_status: check.ok ? 'up' : 'down',
          effective_reason: check.ok ? 'migrated_ok' : 'migrated_down',
          status_code: Number.isFinite(Number(check.status)) ? Number(check.status) : null,
          raw_status_code: Number.isFinite(Number(check.status)) ? Number(check.status) : null,
          latency_ms: clampInt(check.latency_ms, 0, 60000, 0),
          error: check.ok ? null : String(check.error || 'migrated_failure').slice(0, 120),
          source_type: 'worker',
          source_client: null,
          ssl_days_left: Number.isFinite(Number(check.ssl_days_left)) ? Number(check.ssl_days_left) : null,
        },
      });
      checkInserted += 1;
    } catch (error) {
      console.warn(`[warn] check 写入失败（monitor=${monitorId}）：${error.message}`);
    }
  }
  console.log(`website_checks：迁移 ${checkInserted} 条`);

  // -------------------------------------------------------------------------
  // 3) events.json → audit_logs
  // -------------------------------------------------------------------------
  let eventInserted = 0;
  for (const event of eventList) {
    const action = event.action === 'down' ? 'website_alert' : event.action === 'up' ? 'website_recovery' : null;
    if (!action) continue;
    try {
      await rpc('cfm_insert_audit_log', {
        input_user: 'system',
        input_action: action,
        input_detail: String(event.detail || event.message || `${event.action} @ ${event.ts || ''}`).slice(0, 500),
        input_level: 'info',
      });
      eventInserted += 1;
    } catch (error) {
      console.warn(`[warn] audit_log 写入失败：${error.message}`);
    }
  }
  console.log(`audit_logs：迁移 ${eventInserted} 条`);

  // -------------------------------------------------------------------------
  // 4) 抽样校验
  // -------------------------------------------------------------------------
  console.log(`\n=== 抽样校验（最近 ${SAMPLE_SIZE} 条 check）===`);
  const sourceSample = checkList.slice(-SAMPLE_SIZE);
  const sourceUp = sourceSample.filter(c => Boolean(c.ok)).length;
  const sourcePct = sourceSample.length > 0 ? ((sourceUp / sourceSample.length) * 100).toFixed(3) : 'n/a';
  console.log(`源端（site-monitor JSON）：${sourceSample.length} 条，可用 ${sourceUp}，可用率 ${sourcePct}%`);
  console.log('请在迁入后用「SLA 月报」页核对同月同站点的可用率是否一致。');

  console.log('\n=== 迁移完成 ===');
  console.log('下一步：核对无误后即可停用 site-monitor；其 data_host/ 建议压缩备份保留 30 天。');
}

main().catch((error) => {
  console.error('\n[FATAL] 迁移中断：', error.message);
  process.exit(1);
});
