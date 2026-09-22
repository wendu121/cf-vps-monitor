import { useCallback, useEffect, useState } from 'react';
import { Badge, Box, Button, Card, Code, Flex, Heading, Table, Text } from '@radix-ui/themes';
import { CheckCheck, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';

interface QueueItem {
  id: number;
  channel: string;
  subject: string;
  body: string;
  payload: Record<string, unknown> | null;
  delivered: boolean;
  delivered_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export default function AdminAgentMail() {
  const apiFetch = useApi();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acking, setAcking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch('/admin/ops/notifications?limit=100').catch(() => []);
      setItems(Array.isArray(data) ? data as QueueItem[] : []);
    } catch (e) {
      toast.error(`队列加载失败：${(e as Error).message}`);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { load(); }, [load]);

  const ackPending = useCallback(async () => {
    const pending = items.filter(i => !i.delivered).map(i => i.id);
    if (pending.length === 0) {
      toast.message('没有待投递项');
      return;
    }
    setAcking(true);
    try {
      const res = await apiFetch('/admin/ops/notifications/ack', {
        method: 'POST',
        body: JSON.stringify({ ids: pending }),
      }) as { acked?: number };
      toast.success(`已标记 ${res?.acked ?? pending.length} 条为已投递`);
      await load();
    } catch (e) {
      toast.error(`确认失败：${(e as Error).message}`);
    } finally {
      setAcking(false);
    }
  }, [apiFetch, items, load]);

  const pendingCount = items.filter(i => !i.delivered).length;

  if (loading) return <Loading />;

  return (
    <Box>
      <Flex justify="between" align="center" mb="4">
        <Heading size="5">agent-mail 中继队列</Heading>
        <Flex gap="2">
          <Button variant="soft" size="2" onClick={load}><RefreshCw size={14} /> 刷新</Button>
          <Button size="2" onClick={ackPending} disabled={acking || pendingCount === 0}>
            <CheckCheck size={14} /> 全部标记已投递
          </Button>
        </Flex>
      </Flex>

      <Flex gap="3" mb="4" wrap="wrap">
        <Card>
          <Text size="1" color="gray">队列总数</Text>
          <Heading size="6">{items.length}</Heading>
        </Card>
        <Card>
          <Text size="1" color="gray">待投递</Text>
          <Heading size="6" color={pendingCount > 0 ? 'amber' : 'gray'}>{pendingCount}</Heading>
        </Card>
      </Flex>

      <CalloutBox />

      <Card>
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>ID</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>渠道</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>主题</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>状态</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>尝试</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>创建时间</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {items.length === 0 && (
              <Table.Row>
                <Table.Cell colSpan={6}>
                  <Text size="2" color="gray">队列为空。告警触发后会自动入队，供 WorkBuddy 自动化拉取并经 agent-mail 发送。</Text>
                </Table.Cell>
              </Table.Row>
            )}
            {items.map(i => (
              <Table.Row key={i.id}>
                <Table.Cell><Code size="1">{i.id}</Code></Table.Cell>
                <Table.Cell><Text size="2">{i.channel}</Text></Table.Cell>
                <Table.Cell>
                  <Text size="2" weight="medium">{i.subject}</Text>
                  <br />
                  <Text size="1" color="gray" style={{ whiteSpace: 'pre-wrap' }}>
                    {i.body.length > 120 ? `${i.body.slice(0, 120)}…` : i.body}
                  </Text>
                </Table.Cell>
                <Table.Cell>
                  <Badge color={i.delivered ? 'green' : 'amber'}>
                    {i.delivered ? '已投递' : '待投递'}
                  </Badge>
                  {i.last_error && (
                    <>
                      <br />
                      <Text size="1" color="red">{i.last_error}</Text>
                    </>
                  )}
                </Table.Cell>
                <Table.Cell><Text size="2">{i.attempts}</Text></Table.Cell>
                <Table.Cell><Text size="1">{i.created_at?.replace('T', ' ').slice(0, 19)}</Text></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Card>
    </Box>
  );
}

function CalloutBox() {
  return (
    <Card mb="4">
      <Text size="2" color="gray">
        拉取端点（admin 鉴权）：<Code>GET /api/admin/ops/notifications/pending?limit=50</Code>
        {'  '}确认端点：<Code>POST /api/admin/ops/notifications/ack</Code>（body: <Code>{'{ "ids": [1,2] }'}</Code>）
        {'  '}超过 24 小时未确认的条目会由 Cron 自动标记超时。
      </Text>
    </Card>
  );
}
