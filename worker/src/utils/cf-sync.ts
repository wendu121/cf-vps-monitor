/**
 * F1/F3 · CF 资产 + 域名同步核心逻辑（供 admin 路由与 Cron 共用，避免重复实现）。
 *
 * 单事务落库：cfm_sync_cf_domains（upsert 输入集 + 删除旧行），失败整体回滚，绝不留空表。
 */

import * as db from '../db/queries';
import type * as t from '../db/types.ts';
import type { CloudflareApi, CfSslInfo } from './cf-client';

export interface CfSyncResult {
  domains: number;
  zones: number;
  workers: number;
  pages: number;
}

/**
 * 域名 → zone_id 匹配：按 zone name 长度降序，优先最具体 zone。
 * 避免父域（example.com）抢先于子域（a.example.com）导致 SSL 天数错配。
 */
export function matchZoneId(hostname: string, zones: Array<{ id: string; name: string }>): string | null {
  const h = hostname.toLowerCase();
  const sorted = [...zones].sort((a, b) => b.name.length - a.name.length);
  for (const z of sorted) {
    const zn = z.name.toLowerCase();
    if (h === zn || h.endsWith('.' + zn)) return z.id;
  }
  return null;
}

/**
 * 拉取 CF 资产与自定义域名，聚合并落库 cf_domains。
 * @throws CF API 未配置/鉴权失败，或同步过程中的网络错误
 */
export async function syncCfAssets(
  database: db.QueryDatabase,
  api: CloudflareApi,
): Promise<CfSyncResult> {
  const [zones, workers, pages, customDomains] = await Promise.all([
    api.listZones(),
    api.listWorkers(),
    api.listPages(),
    api.getProjectCustomDomains(),
  ]);

  if (!zones.configured) {
    throw new Error('Cloudflare API 未配置或鉴权失败');
  }

  const domainRows: t.CfDomainInput[] = [];
  for (const [script, ds] of Object.entries(customDomains.workers)) {
    for (const d of ds) {
      domainRows.push({
        project_name: script,
        project_type: 'worker',
        domain: d.hostname,
        zone_id: matchZoneId(d.hostname, zones.items),
        ssl_days_left: null,
      });
    }
  }
  for (const [project, ds] of Object.entries(customDomains.pages)) {
    for (const d of ds) {
      domainRows.push({
        project_name: project,
        project_type: 'pages',
        domain: d.hostname,
        zone_id: matchZoneId(d.hostname, zones.items),
        ssl_days_left: null,
      });
    }
  }

  // 按 zone 聚合证书信息（每个 zone 仅查一次）；取该 zone 下任一主机名用于 CT log 降级。
  const zoneIds = Array.from(new Set(domainRows.map(r => r.zone_id).filter(Boolean) as string[]));
  const sslByZone = new Map<string, CfSslInfo>();
  await Promise.all(zoneIds.map(async (zid) => {
    const hostname = domainRows.find(r => r.zone_id === zid)?.domain;
    sslByZone.set(zid, await api.getZoneSslInfo(zid, hostname));
  }));
  for (const r of domainRows) {
    const info = r.zone_id ? sslByZone.get(r.zone_id) : undefined;
    r.ssl_days_left = info?.days ?? null;
    // 来源一并落库：UI 据此区分「CF 官方」与「CT log 估算」，不混淆可信度。
    r.ssl_source = info?.source ?? null;
  }

  // 单事务同步（upsert + 删除旧行）；空输入跳过以防误删全表。
  if (domainRows.length > 0) await db.syncCfDomains(database, domainRows);

  return {
    domains: domainRows.length,
    zones: zones.items.length,
    workers: workers.items.length,
    pages: pages.items.length,
  };
}
