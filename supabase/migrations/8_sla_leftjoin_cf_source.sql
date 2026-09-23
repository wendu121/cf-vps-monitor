-- -----------------------------------------------------------------------------
-- F5 追加迁移（承接 7_sla_month_fix.sql，不修改已审议的迁移 7）
--
-- 包含两处修复：
--
-- (a) SLA 月报 `cfm_website_sla_report`：把 agg 的 **inner join 改 left join**。
--     原实现（含迁移 7）用 `join agg a on a.monitor_id = m.id`，导致「本月尚无检测
--     记录的站点」整行消失 —— 12 个监控项里只要本月没跑过检测，SLA 表就只剩 0 行，
--     UI 表现为「空月报」。改用 left join 后，全部站点都会列出，
--     无数据者 total_checks=0 / sla_pct=null（UI 已按 null 渲染为「—」）。
--     聚合口径、downtime 估算公式、返回字段、函数签名与授权均不变。
--     迁移 7 的月份解析修复（to_date + 月份守卫）在此**原样保留**，因为
--     `create or replace` 会整函数覆盖。
--
-- (b) 网站监控：让 `cfm_create_website_monitor` / `cfm_update_website_monitor`
--     支持 `source` / `cf_zone_id` / `cf_project_name`。
--     这三列在 6_site_monitor.sql 已建立（source 默认 'manual'，带 CHECK
--     `source in ('manual','cf_worker','cf_pages')`），但两个 RPC 函数定义于更早的
--     4_rpc_api.sql，其 INSERT/UPDATE 未引用这三列 → 任何写入都被静默丢成默认值，
--     使「从 CF 资产导入的监控项」无法保留来源归属（F5/P4 的落库前提）。
--
-- 幂等：`create or replace` + 授权重复声明，可安全重跑。
-- -----------------------------------------------------------------------------
set local search_path = public;

-- ---------------------------------------------------------------------------
-- (a) SLA 月报：inner join → left join（保留迁移 7 的月份解析修复）
-- ---------------------------------------------------------------------------
create or replace function public.cfm_website_sla_report(input jsonb)
returns jsonb
language sql
stable
set search_path = public
as $$
  with bounds as (
    select to_date(
      case
        when coalesce(input->>'month', '') ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
          then input->>'month'
        else to_char(now(), 'YYYY-MM')
      end,
      'YYYY-MM'
    ) as m_start
  ),
  agg as (
    select
      wc.monitor_id,
      count(*) as total_checks,
      count(*) filter (where wc.ok) as up_checks,
      round(avg(wc.latency_ms))::integer as avg_latency_ms,
      max(wc.checked_at) as last_checked_at
    from website_checks wc, bounds b
    where wc.checked_at >= b.m_start
      and wc.checked_at < b.m_start + interval '1 month'
    group by wc.monitor_id
  )
  select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'monitor_id', m.id,
      'name', m.name,
      'url', m.url,
      'interval_sec', m.interval_sec,
      'total_checks', coalesce(a.total_checks, 0),
      'up_checks', coalesce(a.up_checks, 0),
      'sla_pct', case when coalesce(a.total_checks, 0) > 0
        then round((coalesce(a.up_checks, 0)::numeric / a.total_checks) * 100, 3)
        else null end,
      'downtime_min', round(
        ((coalesce(a.total_checks, 0) - coalesce(a.up_checks, 0)) * coalesce(m.interval_sec, 0)) / 60.0, 1),
      'avg_latency_ms', a.avg_latency_ms,
      'last_checked_at', a.last_checked_at
    ) as x
    from website_monitors m
    left join agg a on a.monitor_id = m.id
  ) s;
$$;

revoke all on function public.cfm_website_sla_report(jsonb) from public;
revoke all on function public.cfm_website_sla_report(jsonb) from anon;
revoke all on function public.cfm_website_sla_report(jsonb) from authenticated;
grant execute on function public.cfm_website_sla_report(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (b-1) 新建监控项：支持 CF 归属字段
-- ---------------------------------------------------------------------------
create or replace function public.cfm_create_website_monitor(input_monitor jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  created_row website_monitors%rowtype;
begin
  insert into website_monitors (
    name, url, method, expected_status_min, expected_status_max,
    interval_sec, timeout_sec, grace_period_sec, enabled, hidden, hide_url,
    agent_probe_mode, agent_probe_clients, agent_probe_limit, agent_probe_status_enabled,
    source, cf_zone_id, cf_project_name,
    sort_order
  ) values (
    coalesce(input_monitor->>'name', ''),
    coalesce(input_monitor->>'url', ''),
    coalesce(input_monitor->>'method', 'GET'),
    coalesce((input_monitor->>'expected_status_min')::integer, 200),
    coalesce((input_monitor->>'expected_status_max')::integer, 399),
    coalesce((input_monitor->>'interval_sec')::integer, 120),
    coalesce((input_monitor->>'timeout_sec')::integer, 10),
    coalesce((input_monitor->>'grace_period_sec')::integer, 180),
    coalesce((input_monitor->>'enabled')::boolean, true),
    coalesce((input_monitor->>'hidden')::boolean, false),
    coalesce((input_monitor->>'hide_url')::boolean, false),
    case when input_monitor->>'agent_probe_mode' in ('off', 'selected', 'country_auto') then input_monitor->>'agent_probe_mode' else 'country_auto' end,
    case when input_monitor ? 'agent_probe_clients' and jsonb_typeof(input_monitor->'agent_probe_clients') = 'array' then input_monitor->'agent_probe_clients' else '[]'::jsonb end,
    least(greatest(coalesce((input_monitor->>'agent_probe_limit')::integer, 3), 1), 10),
    coalesce((input_monitor->>'agent_probe_status_enabled')::boolean, true),
    -- CHECK 约束守卫：仅接受三枚举值，其余一律回落 'manual'
    case when input_monitor->>'source' in ('manual', 'cf_worker', 'cf_pages') then input_monitor->>'source' else 'manual' end,
    nullif(input_monitor->>'cf_zone_id', ''),
    nullif(input_monitor->>'cf_project_name', ''),
    (select coalesce(max(sort_order), 0) + 1 from website_monitors)
  )
  returning * into created_row;

  return to_jsonb(created_row);
end;
$$;

revoke all on function public.cfm_create_website_monitor(jsonb) from public;
revoke all on function public.cfm_create_website_monitor(jsonb) from anon;
revoke all on function public.cfm_create_website_monitor(jsonb) from authenticated;
grant execute on function public.cfm_create_website_monitor(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (b-2) 更新监控项：支持 CF 归属字段（未传则保持原值）
-- ---------------------------------------------------------------------------
create or replace function public.cfm_update_website_monitor(input_id integer, input_monitor jsonb)
returns jsonb
language sql
set search_path = public
as $$
  update website_monitors
  set
    name = coalesce(input_monitor->>'name', name),
    url = coalesce(input_monitor->>'url', url),
    method = coalesce(input_monitor->>'method', method),
    expected_status_min = coalesce((input_monitor->>'expected_status_min')::integer, expected_status_min),
    expected_status_max = coalesce((input_monitor->>'expected_status_max')::integer, expected_status_max),
    interval_sec = coalesce((input_monitor->>'interval_sec')::integer, interval_sec),
    timeout_sec = coalesce((input_monitor->>'timeout_sec')::integer, timeout_sec),
    grace_period_sec = coalesce((input_monitor->>'grace_period_sec')::integer, grace_period_sec),
    enabled = case when input_monitor ? 'enabled' then coalesce((input_monitor->>'enabled')::boolean, enabled) else enabled end,
    hidden = case when input_monitor ? 'hidden' then coalesce((input_monitor->>'hidden')::boolean, hidden) else hidden end,
    hide_url = case when input_monitor ? 'hide_url' then coalesce((input_monitor->>'hide_url')::boolean, hide_url) else hide_url end,
    agent_probe_mode = case when input_monitor->>'agent_probe_mode' in ('off', 'selected', 'country_auto') then input_monitor->>'agent_probe_mode' else agent_probe_mode end,
    agent_probe_clients = case when input_monitor ? 'agent_probe_clients' and jsonb_typeof(input_monitor->'agent_probe_clients') = 'array' then input_monitor->'agent_probe_clients' else agent_probe_clients end,
    agent_probe_limit = case when input_monitor ? 'agent_probe_limit' then least(greatest(coalesce((input_monitor->>'agent_probe_limit')::integer, agent_probe_limit), 1), 10) else agent_probe_limit end,
    agent_probe_status_enabled = case when input_monitor ? 'agent_probe_status_enabled' then coalesce((input_monitor->>'agent_probe_status_enabled')::boolean, agent_probe_status_enabled) else agent_probe_status_enabled end,
    source = case when input_monitor->>'source' in ('manual', 'cf_worker', 'cf_pages') then input_monitor->>'source' else source end,
    cf_zone_id = coalesce(nullif(input_monitor->>'cf_zone_id', ''), cf_zone_id),
    cf_project_name = coalesce(nullif(input_monitor->>'cf_project_name', ''), cf_project_name),
    updated_at = now()
  where id = input_id
  returning to_jsonb(website_monitors.*);
$$;

revoke all on function public.cfm_update_website_monitor(integer, jsonb) from public;
revoke all on function public.cfm_update_website_monitor(integer, jsonb) from anon;
revoke all on function public.cfm_update_website_monitor(integer, jsonb) from authenticated;
grant execute on function public.cfm_update_website_monitor(integer, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- (c) CF 域名 SSL 数据来源标记：cf_domains.ssl_source
--
-- 背景（线上实测）：生产 CF Token 缺 `SSL and Certificates:Read`，访问
-- /zones/{id}/ssl/certificate_packs、/custom_certificates、/certificates
-- 全部返回 403 code 9109。因此 F5 的取数改为「官方 API 优先，失败降级公开
-- Certificate Transparency log（crt.sh）」。两者可信度不同，必须落库并在 UI
-- 标注来源，绝不让「CT 估算」冒充「CF 官方」。
-- ---------------------------------------------------------------------------
alter table cf_domains add column if not exists ssl_source text;
alter table cf_domains drop constraint if exists cf_domains_ssl_source_check;
alter table cf_domains add constraint cf_domains_ssl_source_check
  check (ssl_source is null or ssl_source in ('cf_api', 'ct_log'));

-- 重声明同步函数以携带 ssl_source（其余逻辑与 6_site_monitor.sql 完全一致）
create or replace function public.cfm_sync_cf_domains(input_rows jsonb)
returns void
language plpgsql
set search_path = public
as $$
begin
  insert into cf_domains (project_name, project_type, domain, zone_id, ssl_days_left, ssl_source, synced_at)
  select
    coalesce(x->>'project_name', ''),
    case when x->>'project_type' in ('worker', 'pages') then x->>'project_type' else 'worker' end,
    coalesce(x->>'domain', ''),
    nullif(x->>'zone_id', ''),
    nullif(x->>'ssl_days_left', '')::integer,
    case when x->>'ssl_source' in ('cf_api', 'ct_log') then x->>'ssl_source' else null end,
    coalesce((x->>'synced_at')::timestamptz, now())
  from jsonb_array_elements(input_rows) as t(x)
  on conflict (project_name, domain) do update set
    project_type = excluded.project_type,
    zone_id = excluded.zone_id,
    ssl_days_left = excluded.ssl_days_left,
    ssl_source = excluded.ssl_source,
    synced_at = excluded.synced_at;

  delete from cf_domains
  where not exists (
    select 1 from jsonb_array_elements(input_rows) as t(x)
    where (x->>'project_name') = cf_domains.project_name
      and (x->>'domain') = cf_domains.domain
  );
end;
$$;

revoke all on function public.cfm_sync_cf_domains(jsonb) from public;
revoke all on function public.cfm_sync_cf_domains(jsonb) from anon;
revoke all on function public.cfm_sync_cf_domains(jsonb) from authenticated;
grant execute on function public.cfm_sync_cf_domains(jsonb) to service_role;
