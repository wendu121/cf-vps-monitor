/**
 * F5 · 深度诊断（移植自 site-monitor 的 diagnoseSite + dohLookup）
 *
 * 纯 Worker 端实现，不落库（结果实时返回 + 由调用方记审计日志）。
 * - DoH：走 Cloudflare 官方 JSON API（https://cloudflare-dns.com/dns-query），Worker 友好。
 * - 限制查询次数：A + AAAA + CNAME 链合计 ≤ DOH_MAX_QUERIES（免费档 CPU 10ms/请求，fetch 属 I/O 不占 CPU）。
 * - 分级输出 reason_code + 中文 reason + suggestion。
 */

export type DiagnoseReasonCode =
  | 'ok'
  | 'dns_error'
  | 'dns_no_record'
  | 'tls_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'http_status_mismatch'
  | 'redirect_loop'
  | 'unreachable'
  | 'timeout'
  | 'invalid_url'
  | 'unsafe_host';

export interface DnsLookupResult {
  /** 解析到的 A/AAAA 记录 */
  addresses: string[];
  /** CNAME 链（不含终点） */
  cnames: string[];
  /** 是否解析成功（至少有 A/AAAA 或最终 CNAME 可解） */
  resolved: boolean;
  /** 失败原因（若有） */
  error: string | null;
}

export interface DiagnoseResult {
  monitor_id: number;
  name: string;
  url: string;
  hostname: string;
  reason_code: DiagnoseReasonCode;
  reason: string;
  suggestion: string;
  dns: DnsLookupResult;
  http: {
    status_code: number | null;
    latency_ms: number | null;
    redirected: boolean;
    final_url: string | null;
    tls_days_left: number | null;
  };
  checked_at: string;
}

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_MAX_QUERIES = 5;
const DOH_TIMEOUT_MS = 8_000;

const SUGGESTIONS: Record<DiagnoseReasonCode, string> = {
  ok: '站点可访问，无需处理。',
  dns_error: 'DNS 查询失败：请检查域名拼写、域名是否已过期、以及权威 DNS 是否正常响应。',
  dns_no_record: '域名无 A/AAAA 记录：请确认已在 DNS 服务商处添加解析记录，或检查是否误删。',
  tls_error: 'TLS/证书错误：请检查证书是否过期、链是否完整、SNI 是否配置正确。',
  http_4xx: '返回 4xx：请确认站点路径是否正确、鉴权/防盗链是否拦截了监控请求。',
  http_5xx: '返回 5xx：源站异常，请检查源服务进程、资源占用与最近部署。',
  http_status_mismatch: '返回状态码不在期望区间：请核对监控配置的期望状态码区间，或修正站点响应。',
  redirect_loop: '检测到重定向异常（循环或跳到非安全地址）：请检查跳转规则与 canonical 配置。',
  unreachable: '网络不可达：请检查防火墙/安全组、Cloudflare 记录是否为「仅 DNS」而源站未放行。',
  timeout: '请求超时：请检查源站响应速度与超时阈值设置，必要时调大 timeout_sec。',
  invalid_url: 'URL 不合法：请使用 http/https 完整地址。',
  unsafe_host: '目标主机不安全（内网/回环/元数据地址）：已拒绝探测。',
};

async function dohQuery(name: string, type: 'A' | 'AAAA' | 'CNAME'): Promise<{ answers: Array<{ data: string }> } | null> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
    const response = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const json = (await response.json()) as { Answer?: Array<{ data?: string }> };
    return { answers: (json.Answer || []).map(a => ({ data: String(a.data || '') })).filter(a => Boolean(a.data)) };
  } catch {
    return null;
  }
}

/** DoH 解析：A + AAAA + 最多 3 跳 CNAME（合计 ≤ DOH_MAX_QUERIES）。 */
export async function dohLookup(hostname: string): Promise<DnsLookupResult> {
  const addresses: string[] = [];
  const cnames: string[] = [];
  let error: string | null = null;
  let queries = 0;

  const resultA = await dohQuery(hostname, 'A');
  queries += 1;
  if (!resultA) {
    error = 'doh_query_failed';
  } else {
    for (const a of resultA.answers) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(a.data)) addresses.push(a.data);
    }
  }

  if (addresses.length === 0) {
    const resultAAAA = await dohQuery(hostname, 'AAAA');
    queries += 1;
    if (resultAAAA) {
      for (const a of resultAAAA.answers) {
        if (a.data.includes(':')) addresses.push(a.data);
      }
    }
  }

  // CNAME 链（仅在无直解时追踪，受查询预算限制）
  let current = hostname;
  while (addresses.length === 0 && cnames.length < 3 && queries < DOH_MAX_QUERIES) {
    const resultCname = await dohQuery(current, 'CNAME');
    queries += 1;
    if (!resultCname || resultCname.answers.length === 0) break;
    const target = resultCname.answers[0].data.replace(/\.$/, '');
    if (!target || target === current || cnames.includes(target)) break;
    cnames.push(target);
    const targetA = await dohQuery(target, 'A');
    queries += 1;
    if (targetA) {
      for (const a of targetA.answers) {
        if (/^\d+\.\d+\.\d+\.\d+$/.test(a.data)) addresses.push(a.data);
      }
    }
    current = target;
  }

  return {
    addresses,
    cnames,
    resolved: addresses.length > 0,
    error: addresses.length > 0 ? null : (error || (cnames.length > 0 ? 'cname_no_address' : 'no_record')),
  };
}

function classifyStatus(status: number, min: number, max: number): DiagnoseReasonCode {
  if (status >= 400 && status <= 499) return 'http_4xx';
  if (status >= 500 && status <= 599) return 'http_5xx';
  if (status >= min && status <= max) return 'ok';
  if (status >= 300 && status <= 399) return 'ok';
  return 'http_status_mismatch';
}

/**
 * 对单个站点做深度诊断：DNS（DoH）→ HTTP → 分级结论。
 * 与 site-monitor 的 diagnoseSite 语义一致，输出结构化的 reason_code + 中文建议。
 */
export async function diagnoseSite(input: {
  id: number;
  name: string;
  url: string;
  method?: 'GET' | 'HEAD' | 'TCP';
  timeout_sec?: number;
  expected_status_min?: number;
  expected_status_max?: number;
}): Promise<DiagnoseResult> {
  const checkedAt = new Date().toISOString();
  const min = input.expected_status_min ?? 200;
  const max = input.expected_status_max ?? 399;
  const timeoutMs = Math.max(1, Math.min(input.timeout_sec ?? 10, 30)) * 1000;

  let hostname = '';
  try {
    hostname = new URL(input.url).hostname;
  } catch {
    return {
      monitor_id: input.id,
      name: input.name,
      url: input.url,
      hostname: '',
      reason_code: 'invalid_url',
      reason: 'URL 无法解析',
      suggestion: SUGGESTIONS.invalid_url,
      dns: { addresses: [], cnames: [], resolved: false, error: 'invalid_url' },
      http: { status_code: null, latency_ms: null, redirected: false, final_url: null, tls_days_left: null },
      checked_at: checkedAt,
    };
  }

  const dns = await dohLookup(hostname);
  if (!dns.resolved) {
    const code: DiagnoseReasonCode = dns.error === 'doh_query_failed' ? 'dns_error' : 'dns_no_record';
    return {
      monitor_id: input.id,
      name: input.name,
      url: input.url,
      hostname,
      reason_code: code,
      reason: code === 'dns_error' ? `DNS 查询失败：${dns.error}` : '域名未解析到任何 A/AAAA 记录',
      suggestion: SUGGESTIONS[code],
      dns,
      http: { status_code: null, latency_ms: null, redirected: false, final_url: null, tls_days_left: null },
      checked_at: checkedAt,
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let statusCode: number | null = null;
  let redirected = false;
  let finalUrl: string | null = null;
  let tlsDaysLeft: number | null = null;

  try {
    const response = await fetch(input.url, {
      method: input.method === 'HEAD' ? 'HEAD' : 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CF-VPS-Monitor/2.0; +https://cf-vps-monitor.local)',
        Accept: '*/*',
      },
    });
    statusCode = response.status;
    const location = response.headers.get('Location');
    if (location && response.status >= 300 && response.status <= 399) {
      redirected = true;
      finalUrl = new URL(location, input.url).toString();
    }
    if (response.body) await response.body.cancel().catch(() => undefined);
  } catch (error) {
    clearTimeout(timer);
    const message = String((error as Error)?.message || error).toLowerCase();
    const code: DiagnoseReasonCode = /certificate|tls|ssl/.test(message)
      ? 'tls_error'
      : /abort|timeout|timed out/.test(message)
        ? 'timeout'
        : /enotfound|dns|getaddrinfo/.test(message)
          ? 'dns_error'
          : 'unreachable';
    return {
      monitor_id: input.id,
      name: input.name,
      url: input.url,
      hostname,
      reason_code: code,
      reason: `请求失败：${message || 'unknown'}`,
      suggestion: SUGGESTIONS[code],
      dns,
      http: { status_code: null, latency_ms: Date.now() - started, redirected, final_url: finalUrl, tls_days_left: null },
      checked_at: checkedAt,
    };
  }
  clearTimeout(timer);

  let code = classifyStatus(statusCode as number, min, max);
  if (code === 'ok' && redirected && finalUrl && new URL(finalUrl).host === hostname && finalUrl === input.url) {
    code = 'redirect_loop';
  }

  return {
    monitor_id: input.id,
    name: input.name,
    url: input.url,
    hostname,
    reason_code: code,
    reason:
      code === 'ok'
        ? `可访问（HTTP ${statusCode}）`
        : `HTTP ${statusCode} 不在期望区间 ${min}-${max}`,
    suggestion: SUGGESTIONS[code],
    dns,
    http: {
      status_code: statusCode,
      latency_ms: Date.now() - started,
      redirected,
      final_url: finalUrl,
      tls_days_left: tlsDaysLeft,
    },
    checked_at: checkedAt,
  };
}
