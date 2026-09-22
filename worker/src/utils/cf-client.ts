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
      const j = await this.cfFetch(`/accounts/${this.accountId}/pages/projects?per_page=100`);
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
        } catch {
          /* 单个项目失败不影响其他 */
        }
      }
    } catch {
      /* 权限不足或接口异常则忽略 */
    }
    return out;
  }

  /**
   * 读取 zone 的证书到期剩余天数（F3 SSL 清单）。
   * 取所有证书中最早 expires_on 与当前时间的差值（天）。需 Zone.Zone:Read（已有）。
   * 任一环节失败返回 null，不阻断主流程。
   */
  async getZoneSslDaysLeft(zoneId: string): Promise<number | null> {
    try {
      const j = await this.cfFetch(`/zones/${zoneId}/certificates?limit=100`);
      const certs: any[] = j.result || [];
      if (certs.length === 0) return null;
      const now = Date.now();
      let minDays: number | null = null;
      for (const c of certs) {
        const exp = Date.parse(c.expires_on || '');
        if (!Number.isFinite(exp)) continue;
        const days = Math.floor((exp - now) / 86_400_000);
        if (minDays === null || days < minDays) minDays = days;
      }
      return minDays;
    } catch (e) {
      // 读取失败不应静默：记录服务日志，便于排障（UI 侧仍显示「未知」）。
      console.error(`[cf-client] getZoneSslDaysLeft failed for zone ${zoneId}:`, e instanceof Error ? e.message : e);
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
