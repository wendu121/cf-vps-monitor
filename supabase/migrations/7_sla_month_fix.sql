-- -----------------------------------------------------------------------------
-- 修复：F4 · SLA 月报 `cfm_website_sla_report` 的月份解析错误。
--
-- 缺陷（线上实测复现）：
--   原 SQL（6_site_monitor.sql:191）把文本直接强转 date：
--     date_trunc('month', coalesce(nullif(input->>'month',''), to_char(now(),'YYYY-MM'))::date)
--   而 `worker/src/routes/ops.ts` 的 parseMonth() 只产出 `YYYY-MM`（正则 ^\d{4}-\d{2}$，
--   缺省取当月），`'2026-09'::date` 在 Postgres 上是非法转换（真库实测：
--   ERROR: invalid input syntax for type date: "2026-09"）。
--   两条路径（显式传月 / 缺省当月）都命中，故线上 F4 面板 100% 报 22007，被兜成 502。
--
-- 修法：
--   1) 用 `to_date(<text>, 'YYYY-MM')` 显式按 YYYY-MM 语义解析（真库实测：
--      to_date('2026-09','YYYY-MM') → 2026-09-01）。
--   2) 加月份合法性守卫：仅当入参严格匹配 ^\d{4}-(0[1-9]|1[0-2])$ 时才采用，
--      否则回落到当月。原因是路由的正则 ^\d{4}-\d{2}$ 会放行 `2026-13` / `2026-00`，
--      而 to_date 对这两种输入会抛 "date/time field value out of range"（真库实测），
--      等于把一个「静默 502」换成另一个错误；同时 to_date('','YYYY-MM') 会静默
--      返回 0001-01-01 BC（真库实测），空白串也需被守卫拦住。
--
-- 未改动：聚合口径、downtime 估算公式、返回字段、join 结构、函数签名与授权。
--
-- ⚠️ 与 6_site_monitor.sql 的关系：这是**追加修复迁移**，不修改已应用的迁移 6
--   （已应用迁移的 version+checksum 不可变，否则会被幂等执行器判为重跑）。
-- -----------------------------------------------------------------------------
set local search_path = public;

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
    join agg a on a.monitor_id = m.id
  ) s;
$$;

revoke all on function public.cfm_website_sla_report(jsonb) from public;
revoke all on function public.cfm_website_sla_report(jsonb) from anon;
revoke all on function public.cfm_website_sla_report(jsonb) from authenticated;
grant execute on function public.cfm_website_sla_report(jsonb) to service_role;
