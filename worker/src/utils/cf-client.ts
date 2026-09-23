// Cloudflare API 客户端（移植自 site-monitor/server/src/cf.js）
//
// 覆盖 F1/F2/F3 所需能力：
//   F1 资产同步  → listZones / listWorkers / listPages
//   F2 一键运维  → purgeCache / setDevMode / rollbackWorker
//   F3 域名清单  → getProjectCustomDomains
//
// 安全约定（见 DESIGN.md 第 6 节）：
//   - 凭据绝不写进代码 / wrangler vars。
//   - 开发期：从 worker/.dev.vars（git-ignored）经 env 注入（CF_API_TOKEN / CF_ACCOUNT_ID）。
//   - 生产期：从 Supabase settings 表读取（RLS 保护，仅 admin RPC 可读），由调用方（route）
//     通过 resolveCfCredentials(env, settings) 的第二个参数传入，本文件不耦合 db。
//
// 权限降级（boss 已实测 Token 全功能可用，含 Zone Settings:Edit / Cache Purge:Purge / Workers Scripts:Edit）：
//   - 各写操作仍保留 403/forbidden 的结构化 { ok:false, reason:'permission' } 返回，
//     前端据 reason 置灰按钮——优雅失败，不静默、不伪装成功。

const CF_API = 'https://api.cloudflare.com/client/v4';

export interface CfCredentials {
  token: string;
  accountId: string;
}

export interface CfZone {
  id: string;
  name: string;
  status: string;
  paused: boolean;
}

export interface CfWorker {
  id: string;
  name: string;
  url: string | null;
}

export interface CfPage {
  id: string;
  name: string;
  subdomain: string | null;
  url: string | null;
  domains: string[];
}

export interface CfCustomDomain {
  hostname: string;
  status?: string;
}

/**
 * SSL 证书到期信息。`source` 明确标注数据来源，供落库与 UI 展示：
 *   - 'cf_api'  → Cloudflare 官方 `/zones/{id}/ssl/certificate_packs`
 *   - 'ct_log'  → 公开 CT log（crt.sh）估算，可能与边缘实际部署证书不同
 *   - null      → 两路都未取到，`error` 给出原因（不伪装成「未知」）
 */
export interface CfSslInfo {
  days: number | null;
  source: 'cf_api' | 'ct_log' | null;
  error?: string;
}

export interface CfListResult<T> {
  configured: boolean;
  items: T[];
  noPermission?: boolean;
  error?: string;
}

export type RollbackResult =
  | { ok: true; rolled_to: string }
  | { ok: false; reason: 'permission' | 'insufficient' | 'notfound'; error?: string };

interface CfEnvShape {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

/**
 * 解析 CF 凭据：优先 env（开发期 .dev.vars），回退 settings（生产期 Supabase settings 表）。
 * @param env        Worker 绑定环境变量（含 .dev.vars 注入项）
 * @param settings   可选，调用方从 db.getSettingsByKeys 取出的 settings map（生产期）
 */
export function resolveCfCredentials(
  env: unknown,
  settings?: Record<string, string | undefined> | null
): CfCredentials | null {
  const e = env as CfEnvShape;
  const token = e.CF_API_TOKEN || settings?.cf_api_token;
  const accountId = e.CF_ACCOUNT_ID || settings?.cf_account_id;
  if (token && accountId) return { token, accountId };
  return null;
}

function isAuthzError(message: string): boolean {
  return /forbidden|permission|403|unauthorized/i.test(message);
}

export class CloudflareApi {
  private readonly token: string;
  private readonly accountId: string;

  constructor(creds: CfCredentials) {
    this.token = creds.token;
    this.accountId = creds.accountId;
  }

  /** 带重试（指数退避）的 CF REST 调用；统一把 success:false / errors[] 抛成 Error。 */
  private async cfFetch(
    path: string,
    opts: RequestInit = {},
    retries = 3
  ): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(CF_API + path, {
          ...opts,
          signal: AbortSignal.timeout(12000),
          headers: {
            Authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
            ...(opts.headers || {}),
          },
        });
        const j = (await res.json().catch(() => ({}))) as any;
        const hasErrors = Array.isArray(j.errors) && j.errors.length > 0;
        if (j.success === false || hasErrors) {
          const msg = hasErrors
            ? j.errors[0]?.message
            : `HTTP ${res.status}`;
          throw new Error(`CF API: ${msg}`);
        }
        return j;
      } catch (e) {
        lastErr = e;
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  /** 列出账号下 active、未暂停的 zone（即 CF 上部署的真实站点）。 */
  async listZones(): Promise<CfListResult<CfZone>> {
    try {
      const j = await this.cfFetch('/zones?status=active&per_page=200');
      const zones: CfZone[] = (j.result || [])
        .filter(
          (z: any) =>
            z.status === 'active' &&
            !z.paused &&
            (!this.accountId || z.account?.id === this.accountId)
        )
        .map((z: any) => ({
          id: z.id,
          name: z.name,
          status: z.status,
          paused: !!z.paused,
        }));
      return { configured: true, items: zones };
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      return { configured: true, items: [], noPermission: isAuthzError(msg), error: msg };
    }
  }

  /** 列出账号下 Workers 脚本（需 Workers Scripts:Read）。 */
  async listWorkers(): Promise<CfListResult<CfWorker>> {
    try {
      const j = await this.cfFetch(
        `/accounts/${this.accountId}/workers/scripts?per_page=200`
      );
      let subdomain: string | null = null;
      try {
        const sd = await this.cfFetch(
          `/accounts/${this.accountId}/workers/subdomain`
        );
        subdomain = sd.result?.subdomain || null;
      } catch {
        /* 无权限则跳过 workers.dev 构造 */
      }
      const workers: CfWorker[] = (j.result || []).map((s: any) => ({
        id: s.id,
        name: s.name || s.id,
        url: subdomain ? `https://${s.name || s.id}.${subdomain}.workers.dev` : null,
      }));
      return { configured: true, items: workers };
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      return { configured: true, items: [], noPermission: isAuthzError(msg), error: msg };
    }
  }

  /** 列出账号下 Pages 项目（需 Cloudflare Pages:Read）。 */
  async listPages(): Promise<CfListResult<CfPage>> {
    try {
      // Pages list 不支持 per_page（带则 400），故不传分页参数拉全量。
      const j = await this.cfFetch(`/accounts/${this.accountId}/pages/projects`);
      const pages: CfPage[] = (j.result || []).map((p: any) => ({
        id: p.id,
        name: p.name,
        subdomain: p.subdomain || null,
        url: p.subdomain ? `https://${p.subdomain}` : null,
        domains: (p.domains || []).map((d: any) => (typeof d === 'string' ? d : d.name)),
      }));
      return { configured: true, items: pages };
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      return { configured: true, items: [], noPermission: isAuthzError(msg), error: msg };
    }
  }

  /**
   * 拉取账号下所有自定义域名，按项目名聚合成两级 map。
   * 关键：项目真正对外服务的是这些带前缀（v./c.）的子域名；zone 裸域名往往无 DNS 记录，
   * 监控必须用项目绑定的子域名，否则误报「离线」。
   */
  async getProjectCustomDomains(): Promise<{
    workers: Record<string, CfCustomDomain[]>;
    pages: Record<string, CfCustomDomain[]>;
  }> {
    const out: { workers: Record<string, CfCustomDomain[]>; pages: Record<string, CfCustomDomain[]> } = {
      workers: {},
      pages: {},
    };
    // 1) Worker 自定义域名（按脚本名聚合）
    try {
      const j = await this.cfFetch(`/accounts/${this.accountId}/workers/domains?per_page=100`);
      for (const d of j.result || []) {
        const script = d.service || d.script_name || d.script;
        if (!script || !d.hostname) continue;
        (out.workers[script] = out.workers[script] || []).push({
          hostname: d.hostname,
          status: d.status,
        });
      }
    } catch {
      /* 权限不足或接口异常则忽略 */
    }
    // 2) Pages 自定义域名（按项目名聚合）
    try {
      // ⚠️ Pages list 不支持任何分页参数：带 `per_page` 会返回 HTTP 400
      // code 8000024（与上方 listPages 同一约束）。此前这里误传了
      // `?per_page=100`，400 又被下面的 catch 吞掉，导致 Pages 自定义域名
      // 整块静默丢失（cf_domains 只剩 worker 的行）。切勿再加回。
      const j = await this.cfFetch(`/accounts/${this.accountId}/pages/projects`);
      for (const p of j.result || []) {
        try {
          const pd = await this.cfFetch(
            `/accounts/${this.accountId}/pages/projects/${p.name}/domains`
          );
          const ds: CfCustomDomain[] = (pd.result || []).map((x: any) => ({
            hostname: x.name,
            status: x.status,
          }));
          if (ds.length) out.pages[p.name] = ds;
        } catch (e) {
          // 不静默：单个项目失败仍需留痕，否则会再次掩盖整块缺失。
          console.warn(`[cf] pages domains for "${p.name}" failed: ${String((e as Error)?.message || e)}`);
        }
      }
    } catch (e) {
      // 不静默：此处曾吞掉 400，使 Pages 域名整块缺失而无人察觉。
      console.warn(`[cf] pages projects list failed: ${String((e as Error)?.message || e)}`);
    }
    return out;
  }

  /**
   * 读取 zone 的证书到期剩余天数（F3 SSL 清单 / F5 增强）。
   *
   * 双路取数并**显式返回来源**，避免把「CT log 估算」冒充「CF 官方」：
   *   1) 主路 `/zones/{id}/ssl/certificate_packs` —— 官方数据，
   *      需 Token 具 `SSL and Certificates:Read`（线上实测：无此权限时
   *      访问 certificate_packs / custom_certificates / certificates 全部
   *      返回 403 code 9109，旧实现的 `/certificates` 因此恒失败 → 「未知」）。
   *   2) 降级：公开 Certificate Transparency log（crt.sh）—— 无需凭据，
   *      但有最长约 1 天的缓存延迟，且**不等于**边缘实际部署的证书。
   * 两路皆失败返回 `{ days:null, source:null, error }`，由 UI 明示原因。
   *
   * @param hostname 可选。用于降级路径查 CT log；不传则仅走官方 API。
   */
  async getZoneSslInfo(zoneId: string, hostname?: string): Promise<CfSslInfo> {
    let primaryError = '';
    try {
      const j = await this.cfFetch(`/zones/${zoneId}/ssl/certificate_packs?per_page=50`);
      const packs: any[] = j.result || [];
      const now = Date.now();
      let minDays: number | null = null;
      for (const p of packs) {
        for (const c of p.certificates || []) {
          const exp = Date.parse(c.expires_on || '');
          if (!Number.isFinite(exp)) continue;
          const days = Math.floor((exp - now) / 86_400_000);
          if (minDays === null || days < minDays) minDays = days;
        }
      }
      if (minDays !== null) return { days: minDays, source: 'cf_api' };
      primaryError = 'CF 未返回证书条目（可能为 CNAME 接入或证书尚未签发）';
    } catch (e) {
      primaryError = e instanceof Error ? e.message : String(e);
    }

    if (hostname) {
      const ct = await this.ctLogSsl(hostname);
      if (ct) return { days: ct.days, source: 'ct_log' };
    }
    console.error(`[cf-client] getZoneSslInfo failed for zone ${zoneId}: ${primaryError}`);
    return { days: null, source: null, error: primaryError };
  }

  /** 公开 CT log 兜底：取该主机名最新（最晚 not_after）已签发证书的剩余天数。 */
  private async ctLogSsl(hostname: string): Promise<{ days: number } | null> {
    try {
      const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(hostname)}&output=json`, {
        signal: AbortSignal.timeout(9000),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const rows = (await res.json().catch(() => [])) as unknown as Array<{ not_after?: string }>;
      if (!Array.isArray(rows)) return null;
      let latest = 0;
      for (const r of rows) {
        const t = Date.parse(r.not_after || '');
        if (Number.isFinite(t) && t > latest) latest = t;
      }
      if (!latest) return null;
      return { days: Math.floor((latest - Date.now()) / 86_400_000) };
    } catch {
      return null;
    }
  }

  /** 清整站缓存（zone 级，需 Cache Purge:Purge）。 */
  async purgeCache(zoneId: string): Promise<{ ok: true } | { ok: false; error: string; reason?: 'permission' }> {
    try {
      await this.cfFetch(`/zones/${zoneId}/purge_cache`, {
        method: 'POST',
        body: JSON.stringify({ purge_everything: true }),
      });
      return { ok: true };
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      return { ok: false, error: msg, ...(isAuthzError(msg) ? { reason: 'permission' as const } : {}) };
    }
  }

  /** 开关开发模式（zone 级 setting，需 Zone.Zone:Edit）。 */
  async setDevMode(
    zoneId: string,
    on: boolean
  ): Promise<{ ok: true; value: string } | { ok: false; error: string; reason?: 'permission' }> {
    try {
      const j = await this.cfFetch(`/zones/${zoneId}/settings/development_mode`, {
        method: 'PATCH',
        body: JSON.stringify({ value: on ? 'on' : 'off' }),
      });
      return { ok: true, value: j.result?.value || (on ? 'on' : 'off') };
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      return { ok: false, error: msg, ...(isAuthzError(msg) ? { reason: 'permission' as const } : {}) };
    }
  }

  /** 读取开发模式当前状态（用于前端 Switch 初始回显，需 Zone.Zone:Edit 或 Settings:Read）。 */
  async getDevMode(
    zoneId: string
  ): Promise<{ ok: true; enabled: boolean } | { ok: false; error: string; reason?: 'permission' }> {
    try {
      const j = await this.cfFetch(`/zones/${zoneId}/settings/development_mode`);
      return { ok: true, enabled: (j.result?.value || 'off') === 'on' };
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      return { ok: false, error: msg, ...(isAuthzError(msg) ? { reason: 'permission' as const } : {}) };
    }
  }

  /**
   * Worker 回滚到上一个部署版本（account 级，需 Workers Scripts:Edit）。
   * 权限降级：boss 当前 Token 仅 Read，遇 403 返回 reason:'permission'，前端据以置灰。
   */
  async rollbackWorker(scriptName: string): Promise<RollbackResult> {
    try {
      const j = await this.cfFetch(
        `/accounts/${this.accountId}/workers/scripts/${scriptName}/deployments`
      );
      const deployments: any[] = j.result?.deployments || [];
      if (deployments.length < 2) {
        return { ok: false, reason: 'insufficient', error: '可用部署版本不足，无法回滚' };
      }
      const target = deployments.find((d, i) => i > 0 && d.id);
      if (!target) return { ok: false, reason: 'notfound', error: '未找到可回滚的目标版本' };
      await this.cfFetch(`/accounts/${this.accountId}/workers/scripts/${scriptName}/deployments`, {
        method: 'POST',
        body: JSON.stringify({ deployment_id: target.id }),
      });
      return { ok: true, rolled_to: target.id };
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (isAuthzError(msg)) return { ok: false, reason: 'permission', error: msg };
      return { ok: false, reason: 'notfound', error: msg };
    }
  }
}
