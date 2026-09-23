import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface LatencyPoint {
  checked_at: string;
  ok: boolean;
  latency_ms: number | null;
}

/**
 * 网站延迟折线图（F5 / G5）。叠加在心跳状态条之上，呈现最近 N 次检测的延迟趋势。
 * 无延迟数据时给出占位提示，绝不伪装成空图表。
 */
export default function WebsiteLatencyChart({ checks, height = 200 }: { checks: LatencyPoint[]; height?: number }) {
  const data = useMemo(
    () =>
      checks
        .filter((c) => c.latency_ms != null)
        .map((c) => ({
          time: new Date(c.checked_at).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
          latency: c.latency_ms as number,
          ok: c.ok,
        })),
    [checks]
  );

  if (data.length === 0) {
    return <div className="admin-latency-empty">暂无延迟数据。</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveEnd" minTickGap={28} />
        <YAxis tick={{ fontSize: 11 }} unit="ms" width={52} />
        <ChartTooltip formatter={(v: number) => [`${v} ms`, '延迟']} />
        <Line type="monotone" dataKey="latency" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
