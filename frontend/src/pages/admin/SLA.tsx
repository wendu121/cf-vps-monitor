import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Box, Button, Card, Flex, Grid, Heading, Table, Text } from '@radix-ui/themes';
import { Download, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';

interface SlaRow {
  monitor_id: number;
  name: string;
  url: string;
  interval_sec: number | null;
  total_checks: number;
  up_checks: number;
  sla_pct: number | null;
  downtime_min: number | null;
  avg_latency_ms: number | null;
  last_checked_at: string | null;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function slaColor(pct: number | null): 'green' | 'amber' | 'red' | 'gray' {
  if (pct === null) return 'gray';
  if (pct >= 99.9) return 'green';
  if (pct >= 99) return 'amber';
  return 'red';
}

export default function AdminSLA() {
  const apiFetch = useApi();
  const [month, setMonth] = useState(currentMonth());
  const [rows, setRows] = useState<SlaRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/admin/ops/sla?month=${month}`).catch(() => null);
      setRows((res as { rows?: SlaRow[] })?.rows ?? []);
    } catch (e) {
      toast.error(`SLA 加载失败：${(e as Error).message}`);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, month]);

  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => {
    const totalChecks = rows.reduce((s, r) => s + r.total_checks, 0);
    const upChecks = rows.reduce((s, r) => s + r.up_checks, 0);
    const overall = totalChecks > 0 ? Math.round((upChecks / totalChecks) * 1000) / 1000 : null;
    const worst = rows.reduce<SlaRow | null>((acc, r) => {
      if (r.sla_pct === null) return acc;
      if (!acc || acc.sla_pct === null || r.sla_pct < acc.sla_pct) return r;
      return acc;
    }, null);
    return { totalChecks, upChecks, overall, worst };
  }, [rows]);

  const chartData = useMemo(
    () => rows.map(r => ({
      name: r.name.length > 12 ? `${r.name.slice(0, 12)}…` : r.name,
      sla: r.sla_pct ?? 0,
    })),
    [rows]
  );

  const exportCsv = useCallback(() => {
    const header = ['monitor_id', 'name', 'url', 'total_checks', 'up_checks', 'sla_pct', 'downtime_min', 'avg_latency_ms'];
    const body = rows.map(r => [
      r.monitor_id, r.name, r.url, r.total_checks, r.up_checks,
      r.sla_pct ?? '', r.downtime_min ?? '', r.avg_latency_ms ?? '',
    ]);
    const csv = [header, ...body].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sla-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows, month]);

  if (loading) return <Loading />;

  return (
    <Box>
      <Flex justify="between" align="center" mb="4">
        <Heading size="5">SLA 月报</Heading>
        <Flex gap="2" align="center">
          <Button variant="soft" size="2" onClick={() => setMonth(m => shiftMonth(m, -1))}>‹ 上月</Button>
          <Text size="2" weight="bold">{month}</Text>
          <Button variant="soft" size="2" onClick={() => setMonth(m => shiftMonth(m, 1))}>下月 ›</Button>
          <Button variant="soft" size="2" onClick={load}><RefreshCw size={14} /> 刷新</Button>
          <Button variant="soft" size="2" onClick={exportCsv}><Download size={14} /> 导出</Button>
        </Flex>
      </Flex>

      <Grid columns={{ initial: '1', sm: '4' }} gap="3" mb="4">
        <Card>
          <Text size="1" color="gray">监控站点</Text>
          <Heading size="6">{rows.length}</Heading>
        </Card>
        <Card>
          <Text size="1" color="gray">检测次数</Text>
          <Heading size="6">{summary.totalChecks}</Heading>
        </Card>
        <Card>
          <Text size="1" color="gray">整体可用率</Text>
          <Heading size="6" color={summary.overall === null ? 'gray' : slaColor(summary.overall)}>
            {summary.overall === null ? '—' : `${summary.overall}%`}
          </Heading>
        </Card>
        <Card>
          <Text size="1" color="gray">最差站点</Text>
          <Heading size="4">{summary.worst ? summary.worst.name : '—'}</Heading>
          <Text size="1" color="gray">{summary.worst?.sla_pct != null ? `${summary.worst.sla_pct}%` : ''}</Text>
        </Card>
      </Grid>

      {rows.length > 0 && (
        <Card mb="4">
          <Heading size="3" mb="3">可用率对比</Heading>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
              <ChartTooltip formatter={(v: number) => [`${v}%`, '可用率']} />
              <Bar dataKey="sla" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      <Card>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>站点</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>检测次数</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>可用次数</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>可用率</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>不可用时长</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>平均延迟</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.length === 0 && (
              <Table.Row>
                <Table.Cell colSpan={6}>
                  <Text size="2" color="gray">本月暂无检测记录。</Text>
                </Table.Cell>
              </Table.Row>
            )}
            {rows.map(r => (
              <Table.Row key={r.monitor_id}>
                <Table.Cell>
                  <Text size="2" weight="medium">{r.name}</Text>
                  <br />
                  <Text size="1" color="gray">{r.url}</Text>
                </Table.Cell>
                <Table.Cell><Text size="2">{r.total_checks}</Text></Table.Cell>
                <Table.Cell><Text size="2">{r.up_checks}</Text></Table.Cell>
                <Table.Cell>
                  <Badge color={slaColor(r.sla_pct)}>
                    {r.sla_pct === null ? '—' : `${r.sla_pct}%`}
                  </Badge>
                </Table.Cell>
                <Table.Cell><Text size="2">{r.downtime_min ?? '—'} 分钟</Text></Table.Cell>
                <Table.Cell><Text size="2">{r.avg_latency_ms ?? '—'} ms</Text></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Card>
    </Box>
  );
}
