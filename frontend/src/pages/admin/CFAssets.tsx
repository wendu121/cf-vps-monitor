import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  Grid,
  Table,
  Text,
  Switch,
  Tooltip,
} from '@radix-ui/themes';
import { Cloud, RefreshCw, Trash2, RotateCcw, Download, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';

interface Zone { id: string; name: string; status: string; paused: boolean }
interface WorkerItem { id: string; name: string; url: string | null }
interface PageItem { id: string; name: string; subdomain: string | null; url: string | null; domains: string[] }
interface AssetsSnapshot {
  configured: boolean;
  zones: Zone[];
  workers: WorkerItem[];
  pages: PageItem[];
  noPermission?: boolean;
  error?: string;
}
interface CfDomain {
  id: number;
  project_name: string;
  project_type: 'worker' | 'pages';
  domain: string;
  zone_id: string | null;
  ssl_days_left: number | null;
  synced_at: string;
}
interface CfSyncRun { id: number; kind: string; ran_at: string; new_count: number; skipped_count: number; error: string | null }

function sslColor(days: number | null): 'red' | 'amber' | 'green' | 'gray' {
  if (days === null || days === undefined) return 'gray';
  if (days <= 14) return 'red';
  if (days <= 30) return 'amber';
  return 'green';
}

function sslLabel(days: number | null): string {
  if (days === null || days === undefined) return '未知';
  if (days < 0) return `已过期 ${-days} 天`;
  return `${days} 天`;
}

export default function AdminCFAssets() {
  const apiFetch = useApi();
  const [assets, setAssets] = useState<AssetsSnapshot | null>(null);
  const [domains, setDomains] = useState<CfDomain[]>([]);
  const [runs, setRuns] = useState<CfSyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [busyZone, setBusyZone] = useState<string | null>(null);
  const [busyWorker, setBusyWorker] = useState<string | null>(null);
  const [devModeLocal, setDevModeLocal] = useState<Record<string, boolean>>({});

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [a, d, r] = await Promise.all([
        apiFetch('/admin/cf/assets').catch(() => null),
        apiFetch('/admin/cf/domains').catch(() => []),
        apiFetch('/admin/cf/sync-runs').catch(() => []),
      ]);
      setAssets((a as AssetsSnapshot) ?? { configured: false, zones: [], workers: [], pages: [] });
      setDomains((d as CfDomain[]) ?? []);
      setRuns((r as CfSyncRun[]) ?? []);
    } catch (e) {
      toast.error(`加载失败：${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // 读取各 zone 开发模式当前状态，用于 Switch 初始回显（避免恒为 off 的误导）。
  useEffect(() => {
    const zones = assets?.zones ?? [];
    if (!zones.length) return;
    let cancelled = false;
    Promise.all(zones.map(async (z: { id: string }) => {
      try {
        const r = await apiFetch(`/admin/cf/zone/${z.id}/dev-mode`).catch(() => null);
        if (cancelled || !r || !(r as { ok?: boolean }).ok) return null;
        return { id: z.id, enabled: Boolean((r as { enabled?: boolean }).enabled) };
      } catch {
        return null;
      }
    })).then((results) => {
      if (cancelled) return;
      const next: Record<string, boolean> = {};
      for (const r of results) if (r) next[r.id] = r.enabled;
      setDevModeLocal(prev => ({ ...prev, ...next }));
    });
    return () => { cancelled = true; };
  }, [assets, apiFetch]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await apiFetch('/admin/cf/sync', { method: 'POST' });
      toast.success(`同步完成：域名 ${res.domains} 个，Worker ${res.workers} 个，Pages ${res.pages} 个`);
      await loadAll();
    } catch (e) {
      toast.error(`同步失败：${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }, [apiFetch, loadAll]);

  const handlePurge = useCallback(async (zoneId: string, zoneName: string) => {
    if (!confirm(`确认清空 ${zoneName} 的 Cloudflare 缓存？`)) return;
    setBusyZone(zoneId);
    try {
      await apiFetch(`/admin/cf/zone/${zoneId}/purge`, { method: 'POST' });
      toast.success(`已清空 ${zoneName} 缓存`);
    } catch (e) {
      toast.error(`清缓存失败：${(e as Error).message}`);
    } finally {
      setBusyZone(null);
    }
  }, [apiFetch]);

  const handleDevMode = useCallback(async (zoneId: string, zoneName: string, on: boolean) => {
    setBusyZone(zoneId);
    try {
      await apiFetch(`/admin/cf/zone/${zoneId}/dev-mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on }),
      });
      setDevModeLocal(prev => ({ ...prev, [zoneId]: on }));
      toast.success(`${zoneName} 开发模式已${on ? '开启' : '关闭'}`);
    } catch (e) {
      toast.error(`开发模式操作失败：${(e as Error).message}`);
    } finally {
      setBusyZone(null);
    }
  }, [apiFetch]);

  const handleRollback = useCallback(async (name: string) => {
    if (!confirm(`确认将 Worker ${name} 回滚到上一版本？`)) return;
    setBusyWorker(name);
    try {
      await apiFetch(`/admin/cf/worker/${encodeURIComponent(name)}/rollback`, { method: 'POST' });
      toast.success(`Worker ${name} 回滚成功`);
    } catch (e) {
      toast.error(`回滚失败：${(e as Error).message}`);
    } finally {
      setBusyWorker(null);
    }
  }, [apiFetch]);

  const exportCsv = useCallback(() => {
    const header = ['project_name', 'project_type', 'domain', 'zone_id', 'ssl_days_left', 'synced_at'];
    const rows = domains.map(d => [d.project_name, d.project_type, d.domain, d.zone_id ?? '', d.ssl_days_left ?? '', d.synced_at]);
    const csv = [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cf-domains-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [domains]);

  const statCards = useMemo(() => [
    { label: 'Zones', value: assets?.zones.length ?? 0 },
    { label: 'Workers', value: assets?.workers.length ?? 0 },
    { label: 'Pages', value: assets?.pages.length ?? 0 },
    { label: '域名（已同步）', value: domains.length },
  ], [assets, domains.length]);

  if (loading) return <Loading />;

  if (assets && !assets.configured) {
    return (
      <Box p="4">
        <Flex align="center" gap="2" mb="3">
          <Cloud size={20} />
          <Text size="5" weight="bold">CF 资产与域名</Text>
        </Flex>
        <Card>
          <Flex align="center" gap="2" mb="2"><AlertTriangle size={18} /><Text weight="bold">CF 凭据未配置</Text></Flex>
          <Text size="2" color="gray">当前无法访问 Cloudflare。开发环境请在 worker/.dev.vars 配置 CF_API_TOKEN / CF_ACCOUNT_ID；生产环境请在系统设置中填写 cf_api_token / cf_account_id。</Text>
        </Card>
      </Box>
    );
  }

  return (
    <Box p="4">
      <Flex align="center" justify="between" mb="3">
        <Flex align="center" gap="2">
          <Cloud size={20} />
          <Text size="5" weight="bold">CF 资产与域名</Text>
        </Flex>
        <Button onClick={handleSync} disabled={syncing}>
          <RefreshCw size={16} /> {syncing ? '同步中…' : '立即同步资产'}
        </Button>
      </Flex>

      {assets?.noPermission && (
        <Card mb="3">
          <Flex align="center" gap="2"><AlertTriangle size={18} /><Text size="2" color="amber">部分接口权限不足：{assets.error}</Text></Flex>
        </Card>
      )}

      <Grid columns={{ initial: '2', sm: '4' }} gap="3" mb="4">
        {statCards.map(s => (
          <Card key={s.label}>
            <Text size="1" color="gray">{s.label}</Text>
            <Text size="6" weight="bold">{s.value}</Text>
          </Card>
        ))}
      </Grid>

      {runs.length > 0 && (
        <Card mb="4">
          <Text size="2" weight="bold" mb="2">最近同步记录</Text>
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>时间</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>类型</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>新增</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>错误</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {runs.slice(0, 8).map(r => (
                <Table.Row key={r.id}>
                  <Table.Cell>{new Date(r.ran_at).toLocaleString()}</Table.Cell>
                  <Table.Cell>{r.kind}</Table.Cell>
                  <Table.Cell>{r.new_count}</Table.Cell>
                  <Table.Cell>{r.error ? <Text color="red">{r.error}</Text> : <Text color="gray">—</Text>}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Card>
      )}

      <Card mb="4">
        <Flex align="center" justify="between" mb="2">
          <Text size="3" weight="bold">域名与 SSL</Text>
          <Button variant="soft" onClick={exportCsv} disabled={domains.length === 0}><Download size={16} /> 导出 CSV</Button>
        </Flex>
        <Table.Root size="1">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>项目</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>类型</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>域名</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>SSL 剩余</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>同步时间</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {domains.length === 0 && (
              <Table.Row><Table.Cell colSpan={5}><Text color="gray">尚未同步，点击右上角「立即同步资产」。</Text></Table.Cell></Table.Row>
            )}
            {domains.map(d => (
              <Table.Row key={d.id}>
                <Table.Cell>{d.project_name}</Table.Cell>
                <Table.Cell><Badge color={d.project_type === 'worker' ? 'cyan' : 'violet'}>{d.project_type}</Badge></Table.Cell>
                <Table.Cell>{d.domain}</Table.Cell>
                <Table.Cell><Badge color={sslColor(d.ssl_days_left)}>{sslLabel(d.ssl_days_left)}</Badge></Table.Cell>
                <Table.Cell>{new Date(d.synced_at).toLocaleString()}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Card>

      <Grid columns={{ initial: '1', md: '2' }} gap="4">
        <Card>
          <Text size="3" weight="bold" mb="2">Zone 一键运维</Text>
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Zone</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>清缓存</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>开发模式</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {assets && assets.zones.map(z => (
                <Table.Row key={z.id}>
                  <Table.Cell>{z.name}</Table.Cell>
                  <Table.Cell>
                    <Button size="1" variant="soft" color="amber" disabled={busyZone === z.id} onClick={() => handlePurge(z.id, z.name)}><Trash2 size={14} /> 清缓存</Button>
                  </Table.Cell>
                  <Table.Cell>
                    <Tooltip content="切换 Cloudflare 开发模式（绕过缓存，便于调试）">
                      <Switch size="1" checked={devModeLocal[z.id] ?? false} disabled={busyZone === z.id} onCheckedChange={(v) => handleDevMode(z.id, z.name, Boolean(v))} />
                    </Tooltip>
                  </Table.Cell>
                </Table.Row>
              ))}
              {assets && assets.zones.length === 0 && (
                <Table.Row><Table.Cell colSpan={3}><Text color="gray">无 Zone</Text></Table.Cell></Table.Row>
              )}
            </Table.Body>
          </Table.Root>
        </Card>

        <Card>
          <Text size="3" weight="bold" mb="2">Worker 一键运维</Text>
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Worker</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>回滚</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {assets && assets.workers.map(w => (
                <Table.Row key={w.id}>
                  <Table.Cell>{w.name}</Table.Cell>
                  <Table.Cell>
                    <Button size="1" variant="soft" color="gray" disabled={busyWorker === w.name} onClick={() => handleRollback(w.name)}><RotateCcw size={14} /> 回滚</Button>
                  </Table.Cell>
                </Table.Row>
              ))}
              {assets && assets.workers.length === 0 && (
                <Table.Row><Table.Cell colSpan={2}><Text color="gray">无 Worker</Text></Table.Cell></Table.Row>
              )}
            </Table.Body>
          </Table.Root>
        </Card>
      </Grid>
    </Box>
  );
}
