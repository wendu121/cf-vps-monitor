import { useCallback, useEffect, useState } from 'react';
import { Badge, Box, Card, Flex, Heading, Separator, Text } from '@radix-ui/themes';
import Loading from '../components/Loading';

interface StatusSite {
  id: number;
  name: string;
  url: string | null;
  method: string;
  status: string;
  last_checked_at: string | null;
  last_status_code: number | null;
  last_latency_ms: number | null;
  uptime_pct: number | null;
  checks_count: number;
}

interface StatusPayload {
  generated_at: string;
  period_hours: number;
  total: number;
  operational: number;
  degraded: number;
  overall: 'operational' | 'partial_outage' | 'major_outage';
  sites: StatusSite[];
}

const OVERALL_TEXT: Record<StatusPayload['overall'], { label: string; color: 'green' | 'amber' | 'red' }> = {
  operational: { label: '所有服务运行正常', color: 'green' },
  partial_outage: { label: '部分服务异常', color: 'amber' },
  major_outage: { label: '服务中断', color: 'red' },
};

/**
 * F7 · 公开状态页（免登录，只读）。
 * 数据来自 GET /api/public/status（公开端点，不携带任何凭据）。
 */
export default function StatusPage() {
  const [data, setData] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/public/status');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData((await response.json()) as StatusPayload);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Loading />;

  if (error || !data) {
    return (
      <Box p="6">
        <Heading size="5" mb="2">服务状态</Heading>
        <Text color="gray">暂时无法获取状态数据{error ? `：${error}` : ''}。</Text>
      </Box>
    );
  }

  const overall = OVERALL_TEXT[data.overall];

  return (
    <Box p="6" style={{ maxWidth: 880, margin: '0 auto' }}>
      <Flex justify="between" align="center" mb="4">
        <Heading size="6">服务状态</Heading>
        <Text size="1" color="gray">
          更新于 {data.generated_at.replace('T', ' ').slice(0, 19)}（近 {data.period_hours} 小时）
        </Text>
      </Flex>

      <Card mb="4">
        <Flex align="center" gap="3">
          <Badge color={overall.color} size="3">{overall.label}</Badge>
          <Text size="2" color="gray">
            {data.operational} / {data.total} 项正常
          </Text>
        </Flex>
      </Card>

      <Card>
        {data.sites.length === 0 && <Text size="2" color="gray">暂无公开的监控项。</Text>}
        {data.sites.map((site, index) => (
          <Box key={site.id}>
            {index > 0 && <Separator size="4" my="3" />}
            <Flex justify="between" align="center">
              <Box>
                <Text size="2" weight="medium">{site.name}</Text>
                <br />
                <Text size="1" color="gray">{site.url ?? '（地址已隐藏）'}</Text>
              </Box>
              <Flex gap="3" align="center">
                <Text size="1" color="gray">
                  {site.uptime_pct === null ? '—' : `${site.uptime_pct}%`}
                </Text>
                <Text size="1" color="gray">
                  {site.last_latency_ms === null ? '—' : `${site.last_latency_ms} ms`}
                </Text>
                <Badge color={site.status === 'up' ? 'green' : 'red'}>
                  {site.status === 'up' ? '正常' : '异常'}
                </Badge>
              </Flex>
            </Flex>
          </Box>
        ))}
      </Card>
    </Box>
  );
}
