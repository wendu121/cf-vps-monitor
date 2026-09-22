import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Flex,
  Heading,
  Select,
  Separator,
  Text,
} from '@radix-ui/themes';
import { Activity, Info, Stethoscope } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';

interface Monitor { id: number; name: string; url: string }

interface DiagnoseResult {
  monitor_id: number;
  name: string;
  url: string;
  hostname: string;
  reason_code: string;
  reason: string;
  suggestion: string;
  dns: { addresses: string[]; cnames: string[]; resolved: boolean; error: string | null };
  http: {
    status_code: number | null;
    latency_ms: number | null;
    redirected: boolean;
    final_url: string | null;
    tls_days_left: number | null;
  };
  checked_at: string;
}

function codeColor(code: string): 'green' | 'red' | 'amber' | 'gray' {
  if (code === 'ok') return 'green';
  if (code === 'unreachable' || code === 'dns_error' || code === 'tls_error') return 'red';
  if (code === 'invalid_url' || code === 'unsafe_host') return 'gray';
  return 'amber';
}

export default function AdminDiagnose() {
  const apiFetch = useApi();
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch('/admin/websites').catch(() => []);
        const list = (Array.isArray(data) ? data : (data as { monitors?: Monitor[] })?.monitors ?? []) as Monitor[];
        setMonitors(list);
        if (list.length > 0) setSelected(String(list[0].id));
      } catch {
        setMonitors([]);
      } finally {
        setLoadingList(false);
      }
    })();
  }, [apiFetch]);

  const run = useCallback(async () => {
    if (!selected) return;
    setRunning(true);
    setResult(null);
    try {
      const data = await apiFetch(`/admin/ops/websites/${selected}/diagnose`);
      setResult(data as DiagnoseResult);
    } catch (e) {
      toast.error(`诊断失败：${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  }, [apiFetch, selected]);

  if (loadingList) return <Loading />;

  return (
    <Box>
      <Flex justify="between" align="center" mb="4">
        <Heading size="5">深度诊断</Heading>
      </Flex>

      <Card mb="4">
        <Flex gap="3" align="end" wrap="wrap">
          <Box style={{ minWidth: 260 }}>
            <Text size="1" color="gray" mb="1">选择站点</Text>
            <Select.Root value={selected} onValueChange={setSelected}>
              <Select.Trigger placeholder="选择要诊断的站点" />
              <Select.Content>
                {monitors.length === 0 && <Select.Item value="__none__">暂无站点</Select.Item>}
                {monitors.map(m => (
                  <Select.Item key={m.id} value={String(m.id)}>{m.name}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Box>
          <Button onClick={run} disabled={running || !selected}>
            <Stethoscope size={14} /> {running ? '诊断中…' : '开始诊断'}
          </Button>
        </Flex>
      </Card>

      {!result && (
        <Callout.Root>
          <Callout.Icon><Info size={14} /></Callout.Icon>
          <Callout.Text>
            诊断会执行 DoH DNS 解析（Cloudflare DNS）与一次 HTTP 探测，输出分级原因码与修复建议。
          </Callout.Text>
        </Callout.Root>
      )}

      {result && (
        <Card>
          <Flex justify="between" align="center" mb="3">
            <Heading size="4">{result.name}</Heading>
            <Badge color={codeColor(result.reason_code)} size="2">{result.reason_code}</Badge>
          </Flex>

          <Text size="2" mb="2"><b>结论：</b>{result.reason}</Text>
          <Callout.Root color={result.reason_code === 'ok' ? 'green' : 'amber'} mb="3">
            <Callout.Icon><Activity size={14} /></Callout.Icon>
            <Callout.Text><b>建议：</b>{result.suggestion}</Callout.Text>
          </Callout.Root>

          <Separator size="4" my="3" />

          <Heading size="3" mb="2">DNS（DoH）</Heading>
          <Flex gap="4" wrap="wrap" mb="2">
            <Text size="2">解析状态：<b>{result.dns.resolved ? '成功' : '失败'}</b></Text>
            <Text size="2">A/AAAA：<Code>{result.dns.addresses.length ? result.dns.addresses.join(', ') : '无'}</Code></Text>
            <Text size="2">CNAME 链：<Code>{result.dns.cnames.length ? result.dns.cnames.join(' → ') : '无'}</Code></Text>
          </Flex>

          <Separator size="4" my="3" />

          <Heading size="3" mb="2">HTTP</Heading>
          <Flex gap="4" wrap="wrap" mb="2">
            <Text size="2">状态码：<Code>{result.http.status_code ?? '—'}</Code></Text>
            <Text size="2">延迟：<Code>{result.http.latency_ms ?? '—'} ms</Code></Text>
            <Text size="2">重定向：<Code>{result.http.redirected ? '是' : '否'}</Code></Text>
            {result.http.final_url && <Text size="2">目标：<Code>{result.http.final_url}</Code></Text>}
          </Flex>

          <Text size="1" color="gray">诊断时间：{result.checked_at}</Text>
        </Card>
      )}
    </Box>
  );
}
