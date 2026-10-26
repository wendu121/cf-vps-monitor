export interface PublicMonitorRecord {
  time: string;
  cpu: number | null;
  ram: number | null;
  ram_total: number | null;
  swap: number | null;
  swap_total: number | null;
  disk: number | null;
  disk_total: number | null;
  // null = 探针报告本机负载不可取信（容器内 /proc/loadavg 透传宿主机），不是 0。
  load: number | null;
  temp: number | null;
  net_in: number | null;
  net_out: number | null;
  net_total_up: number | null;
  net_total_down: number | null;
  process_count: number;
  connections: number;
  connections_udp: number;
  uptime: number | null;
}

export interface PublicGpuRecord {
  time: string;
  utilization: number;
  mem_total: number;
  mem_used: number;
  temperature: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function listItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  return Array.isArray(record?.data) ? record.data : [];
}

function timeField(record: Record<string, unknown>): string | null {
  const value = record.time;
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime()) ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  if (!(key in record) || record[key] === undefined) return 0;
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function allNumbers<K extends string>(values: Record<K, number | null>): values is Record<K, number> {
  return Object.values(values).every((value): value is number => value !== null);
}

function optionalMetric(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// 显式 null 是未测得；旧记录缺字段仍兼容 0。undefined 只表示非法输入。
// 不能再用 allNumbers 统一判否：那样任一指标不可用都会**整条记录被丢弃**——
// 后果是那台节点的历史图表整段消失，而不是只缺一项。
function nullableNumberField(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === undefined) return 0;
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizePublicMonitorRecord(payload: unknown): PublicMonitorRecord | null {
  const record = asRecord(payload);
  if (!record) return null;
  const time = timeField(record);
  if (!time) return null;
  const load = nullableNumberField(record, 'load');
  if (load === undefined) return null;
  // 温度未知不能补成 0，也不能丢弃同一条记录中的 CPU 等有效指标。
  const temp = typeof record.temp === 'number' && Number.isFinite(record.temp) ? record.temp : null;
  const metrics = {
    cpu: nullableNumberField(record, 'cpu'),
    ram: nullableNumberField(record, 'ram'),
    ram_total: nullableNumberField(record, 'ram_total'),
    swap: nullableNumberField(record, 'swap'),
    swap_total: nullableNumberField(record, 'swap_total'),
    net_in: nullableNumberField(record, 'net_in'),
    net_out: nullableNumberField(record, 'net_out'),
    net_total_up: nullableNumberField(record, 'net_total_up'),
    net_total_down: nullableNumberField(record, 'net_total_down'),
  };
  if (Object.values(metrics).some(value => value === undefined)) return null;
  const values = {
    process_count: numberField(record, 'process_count'),
    connections: numberField(record, 'connections'),
    connections_udp: numberField(record, 'connections_udp'),
  };
  if (!allNumbers(values)) return null;

  return {
    time,
    ...metrics as Record<keyof typeof metrics, number | null>,
    disk: optionalMetric(record, 'disk'),
    disk_total: optionalMetric(record, 'disk_total'),
    load,
    temp,
    process_count: values.process_count,
    connections: values.connections,
    connections_udp: values.connections_udp,
    uptime: optionalMetric(record, 'uptime'),
  };
}

export function normalizePublicMonitorRecords(payload: unknown): PublicMonitorRecord[] {
  return listItems(payload).flatMap((item) => {
    const record = normalizePublicMonitorRecord(item);
    return record ? [record] : [];
  });
}

export function normalizePublicGpuRecord(payload: unknown): PublicGpuRecord | null {
  const record = asRecord(payload);
  if (!record) return null;
  const time = timeField(record);
  if (!time) return null;
  const values = {
    utilization: numberField(record, 'utilization'),
    mem_total: numberField(record, 'mem_total'),
    mem_used: numberField(record, 'mem_used'),
    temperature: numberField(record, 'temperature'),
  };
  if (!allNumbers(values)) return null;

  return {
    time,
    utilization: values.utilization,
    mem_total: values.mem_total,
    mem_used: values.mem_used,
    temperature: values.temperature,
  };
}

export function normalizePublicGpuRecords(payload: unknown): PublicGpuRecord[] {
  return listItems(payload).flatMap((item) => {
    const record = normalizePublicGpuRecord(item);
    return record ? [record] : [];
  });
}

export async function collectCursorHistory<T extends { time: string }>(
  fetchPage: (cursor: string) => Promise<unknown>,
  options: {
    cursor: string;
    start: string;
    end?: string;
    normalize: (payload: unknown) => T[];
    signal?: AbortSignal;
    maxPages?: number;
  },
): Promise<T[]> {
  const start = Date.parse(options.start);
  const end = Date.parse(options.end || options.cursor);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new Error('历史时间范围无效');
  const records = new Map<number, T>();
  const result = () => [...records.entries()].sort(([a], [b]) => a - b).map(([, record]) => record);
  let cursor = options.cursor;
  const maxPages = Math.min(32, Math.max(1, options.maxPages ?? 32));
  for (let page = 0; page < maxPages; page += 1) {
    options.signal?.throwIfAborted();
    const payload = await fetchPage(cursor);
    options.signal?.throwIfAborted();
    const envelope = asRecord(payload);
    if (!Array.isArray(payload) && !Array.isArray(envelope?.data)) throw new Error('历史记录响应格式无效');
    for (const record of options.normalize(payload)) {
      const at = Date.parse(record.time);
      if (at >= start && at <= end) records.set(at, record);
    }
    if (envelope?.has_more !== true) return result();
    const next = typeof envelope.next_cursor === 'string' ? envelope.next_cursor : '';
    const nextAt = Date.parse(next);
    if (!Number.isFinite(nextAt) || nextAt >= Date.parse(cursor)) throw new Error('历史分页游标无效');
    if (nextAt <= start) return result();
    cursor = next;
  }
  throw new Error('历史记录过多，请选择更短的时间范围');
}
