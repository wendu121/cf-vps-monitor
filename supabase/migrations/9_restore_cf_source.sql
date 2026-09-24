-- -----------------------------------------------------------------------------
-- 迁移 9：补上「备份还原」路径的 CF 归属字段（闭环 follow-up #1）
--
-- 背景（线上实测 + 评审遗留问题）：
--   * 迁移 6 在 website_monitors 上建立了 source / cf_zone_id / cf_project_name
--     三列（source 默认 'manual'，CHECK 约束 in ('manual','cf_worker','cf_pages')）。
--   * 迁移 8 让 cfm_create_website_monitor / cfm_update_website_monitor 写入这三列。
--   * 导出快照 backup.ts（已随 HEAD e86a7c7 上线）现在会带出这三列。
--   * 但 cfm_restore_backup_data（定义于更早的 4_rpc_api.sql）的 website_monitors
--     UPSERT 从未引用这三列 —— 于是「导出时带 CF 归属、还原时静默丢 CF 归属」的
--     半修复闭环缺口。任何从 CF 资产导入的监控项，一旦走备份还原就会被打回 'manual'
--     且 cf_zone_id / cf_project_name 清零，CF 来源归属永久丢失。
--
-- 本迁移用 create or replace 整函数重定义 cfm_restore_backup_data，仅在
-- website_monitors 的 UPSERT 处补上三列，其余逻辑（client / ping_tasks /
-- offline_notifications / expiry_notifications / load_notifications 等）原样保留。
--
-- 写入口径（与迁移 8 完全对齐）：
--   * source：仅接受三枚举值，否则回落 'manual'（CHECK 约束守卫）。
--   * cf_zone_id / cf_project_name：nullif(..., '') 后落库（空串转 NULL）。
--   * ON CONFLICT DO UPDATE：备份未携带该列时**保留现有值**（coalesce(nullif(...), col) /
--     else col），而非用 'manual'/NULL 覆盖 —— 还原路径对这三列采取「保守保留」语义：
--     旧备份（迁移 6 之前）根本不含这三列，若强制覆盖会把线上仍存活的 cf_worker 监控项
--     的归属抹掉；带值的备份则正常覆盖。与更新 RPC「未传则保持原值」一致。
--
-- 幂等：create or replace + 授权重复声明 + search_path 显式，可安全重跑。
-- -----------------------------------------------------------------------------
set local search_path = public;

create or replace function public.cfm_restore_backup_data(input_backup jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  item jsonb;
  client_ids text[];
  task_ids bigint[];
  website_ids bigint[];
begin
  if input_backup is null or jsonb_typeof(input_backup) <> 'object' then
    raise exception 'backup must be a JSON object';
  end if;

  if input_backup ? 'settings' and jsonb_typeof(input_backup->'settings') = 'object' then
    insert into settings (key, value)
    select key, value
    from jsonb_each_text(input_backup->'settings')
    where trim(key) <> ''
    on conflict (key) do update set value = excluded.value;
  end if;

  if input_backup ? 'clients' and jsonb_typeof(input_backup->'clients') = 'array' then
    select coalesce(array_agg(uuid), array[]::text[]) into client_ids
    from (
      select nullif(trim(value->>'uuid'), '') as uuid
      from jsonb_array_elements(input_backup->'clients')
    ) rows
    where uuid is not null;

    delete from records where not (client = any(client_ids));
    delete from gpu_records where not (client = any(client_ids));
    delete from gpu_snapshots where not (client = any(client_ids));
    delete from ping_records where not (client = any(client_ids));
    delete from ping_snapshots where not (client = any(client_ids));
    delete from offline_notifications where not (client = any(client_ids));
    delete from expiry_notifications where not (client = any(client_ids));
    delete from clients where not (uuid = any(client_ids));

    for item in select value from jsonb_array_elements(input_backup->'clients')
    loop
      if nullif(trim(item->>'uuid'), '') is null then
        continue;
      end if;

      insert into clients (
        uuid, token, token_hash, token_last_used_at, token_last_used_ip, token_rotated_at,
        name, cpu_name, virtualization, arch, cpu_cores, os, kernel_version, gpu_name,
        ipv4, ipv6, region, remark, public_remark, mem_total, swap_total, disk_total,
        version, price, billing_cycle, auto_renewal, currency, expired_at, "group", tags,
        hidden, traffic_limit, traffic_limit_type, traffic_reset_day, sort_order, created_at, updated_at
      )
      values (
        item->>'uuid',
        nullif(item->>'token', ''),
        nullif(item->>'token_hash', ''),
        nullif(item->>'token_last_used_at', '')::timestamptz,
        coalesce(item->>'token_last_used_ip', ''),
        nullif(item->>'token_rotated_at', '')::timestamptz,
        coalesce(item->>'name', ''),
        coalesce(item->>'cpu_name', ''),
        coalesce(item->>'virtualization', ''),
        coalesce(item->>'arch', ''),
        coalesce((item->>'cpu_cores')::integer, 0),
        coalesce(item->>'os', ''),
        coalesce(item->>'kernel_version', ''),
        coalesce(item->>'gpu_name', ''),
        coalesce(item->>'ipv4', ''),
        coalesce(item->>'ipv6', ''),
        coalesce(item->>'region', ''),
        coalesce(item->>'remark', ''),
        coalesce(item->>'public_remark', ''),
        coalesce((item->>'mem_total')::bigint, 0),
        coalesce((item->>'swap_total')::bigint, 0),
        coalesce((item->>'disk_total')::bigint, 0),
        coalesce(item->>'version', ''),
        coalesce((item->>'price')::double precision, 0),
        coalesce((item->>'billing_cycle')::smallint, 0),
        case when coalesce((item->>'auto_renewal')::boolean, false) then 1 else 0 end,
        coalesce(item->>'currency', '$'),
        nullif(item->>'expired_at', '')::timestamptz,
        coalesce(item->>'group', ''),
        coalesce(item->>'tags', ''),
        case when coalesce((item->>'hidden')::boolean, false) then 1 else 0 end,
        coalesce((item->>'traffic_limit')::bigint, 0),
        -- 兜底值与 cfm_create_client / cfm_update_client 保持一致（'sum'）；
        -- 还原路径漏改会让从旧备份恢复的节点静默回到 'max' 口径。
        coalesce(nullif(item->>'traffic_limit_type', ''), 'sum'),
        -- 缺省补 1 并钳到 1~31：列上有 check 约束，直接写 0 会让整个还原事务失败。
        least(greatest(coalesce((item->>'traffic_reset_day')::smallint, 1), 1), 31),
        coalesce((item->>'sort_order')::integer, 0),
        coalesce(nullif(item->>'created_at', '')::timestamptz, now()),
        coalesce(nullif(item->>'updated_at', '')::timestamptz, now())
      )
      on conflict (uuid) do update set
        token = excluded.token,
        token_hash = excluded.token_hash,
        token_last_used_at = excluded.token_last_used_at,
        token_last_used_ip = excluded.token_last_used_ip,
        token_rotated_at = excluded.token_rotated_at,
        name = excluded.name,
        cpu_name = excluded.cpu_name,
        virtualization = excluded.virtualization,
        arch = excluded.arch,
        cpu_cores = excluded.cpu_cores,
        os = excluded.os,
        kernel_version = excluded.kernel_version,
        gpu_name = excluded.gpu_name,
        ipv4 = excluded.ipv4,
        ipv6 = excluded.ipv6,
        region = excluded.region,
        remark = excluded.remark,
        public_remark = excluded.public_remark,
        mem_total = excluded.mem_total,
        swap_total = excluded.swap_total,
        disk_total = excluded.disk_total,
        version = excluded.version,
        price = excluded.price,
        billing_cycle = excluded.billing_cycle,
        auto_renewal = excluded.auto_renewal,
        currency = excluded.currency,
        expired_at = excluded.expired_at,
        "group" = excluded."group",
        tags = excluded.tags,
        hidden = excluded.hidden,
        traffic_limit = excluded.traffic_limit,
        traffic_limit_type = excluded.traffic_limit_type,
        traffic_reset_day = excluded.traffic_reset_day,
        sort_order = excluded.sort_order,
        updated_at = now();
      perform cfm_internal.retire_client_notification_deliveries(item->>'uuid');
    end loop;
  end if;

  if input_backup ? 'website_monitors' then
    if jsonb_typeof(input_backup->'website_monitors') <> 'array' then
      raise exception 'website_monitors must be an array';
    end if;
    if exists (
      select 1 from jsonb_array_elements(input_backup->'website_monitors') row_data
      where jsonb_typeof(row_data) <> 'object'
        or (row_data ? 'id' and (coalesce(row_data->>'id', '') !~ '^[1-9][0-9]*$'
          or (row_data->>'id')::numeric > 9007199254740991))
    ) then
      raise exception 'invalid website monitor identity';
    end if;
    if exists (
      select (value->>'id')::bigint
      from jsonb_array_elements(input_backup->'website_monitors')
      where value ? 'id'
      group by (value->>'id')::bigint having count(*) > 1
    ) then
      raise exception 'duplicate website monitor identity';
    end if;
    select coalesce(array_agg((value->>'id')::bigint), array[]::bigint[])
      into website_ids
    from jsonb_array_elements(input_backup->'website_monitors') where value ? 'id';

    -- setval is not rolled back: never move below existing or already allocated
    -- identities, even if a later module rejects the transaction. Serialize
    -- writers while reserving explicit IDs ahead of entries without an ID.
    lock table website_monitors in share row exclusive mode;
    perform setval(pg_get_serial_sequence('website_monitors', 'id'),
      greatest(
        coalesce((select max(id) from website_monitors), 0) + 1,
        coalesce((select max(id) from unnest(website_ids) as restored(id)), 0) + 1,
        nextval(pg_get_serial_sequence('website_monitors', 'id'))
      ), false);
    delete from website_monitors where not (id = any(website_ids));

    for item in select value from jsonb_array_elements(input_backup->'website_monitors')
    loop
      if item ? 'agent_probe_clients' and jsonb_typeof(item->'agent_probe_clients') <> 'array' then
        raise exception 'website monitor agents must be an array';
      end if;
      if exists (
        select 1 from jsonb_array_elements_text(coalesce(item->'agent_probe_clients', '[]'::jsonb)) as agents(uuid)
        where not exists (select 1 from clients where clients.uuid = agents.uuid)
      ) then
        raise exception 'website monitor references an unknown agent';
      end if;
      insert into website_monitors (
        id, name, url, method, expected_status_min, expected_status_max,
        interval_sec, timeout_sec, grace_period_sec, enabled, hidden, hide_url,
        agent_probe_mode, agent_probe_clients, agent_probe_limit, agent_probe_status_enabled,
        source, cf_zone_id, cf_project_name,
        sort_order, status
      ) values (
        coalesce((item->>'id')::bigint, nextval(pg_get_serial_sequence('website_monitors', 'id'))),
        coalesce(item->>'name', ''), coalesce(item->>'url', ''), coalesce(item->>'method', 'GET'),
        coalesce((item->>'expected_status_min')::integer, 200),
        coalesce((item->>'expected_status_max')::integer, 399),
        coalesce((item->>'interval_sec')::integer, 120), coalesce((item->>'timeout_sec')::integer, 10),
        coalesce((item->>'grace_period_sec')::integer, 180), coalesce((item->>'enabled')::boolean, true),
        coalesce((item->>'hidden')::boolean, false), coalesce((item->>'hide_url')::boolean, false),
        coalesce(item->>'agent_probe_mode', 'off'), coalesce(item->'agent_probe_clients', '[]'::jsonb),
        coalesce((item->>'agent_probe_limit')::integer, 3),
        coalesce((item->>'agent_probe_status_enabled')::boolean, true),
        -- CHECK 约束守卫：仅接受三枚举值，其余一律回落 'manual'
        case when item->>'source' in ('manual', 'cf_worker', 'cf_pages') then item->>'source' else 'manual' end,
        nullif(item->>'cf_zone_id', ''),
        nullif(item->>'cf_project_name', ''),
        coalesce((item->>'sort_order')::integer, 0),
        case when coalesce((item->>'enabled')::boolean, true) then 'pending' else 'paused' end
      )
      on conflict (id) do update set
        name = excluded.name, url = excluded.url, method = excluded.method,
        expected_status_min = excluded.expected_status_min, expected_status_max = excluded.expected_status_max,
        interval_sec = excluded.interval_sec, timeout_sec = excluded.timeout_sec,
        grace_period_sec = excluded.grace_period_sec, enabled = excluded.enabled,
        hidden = excluded.hidden, hide_url = excluded.hide_url,
        agent_probe_mode = excluded.agent_probe_mode, agent_probe_clients = excluded.agent_probe_clients,
        agent_probe_limit = excluded.agent_probe_limit, agent_probe_status_enabled = excluded.agent_probe_status_enabled,
        -- 还原路径对 CF 归属采取保守保留：备份未携带则保留现有值，避免抹掉线上归属。
        -- ON CONFLICT DO UPDATE 里裸列名在 target 表与 excluded 间歧义，必须显式用
        -- website_monitors.<col> 指代「现有行」值（excluded.<col> 才是本次待写入值）。
        source = case when item->>'source' in ('manual', 'cf_worker', 'cf_pages') then item->>'source' else website_monitors.source end,
        cf_zone_id = coalesce(nullif(item->>'cf_zone_id', ''), website_monitors.cf_zone_id),
        cf_project_name = coalesce(nullif(item->>'cf_project_name', ''), website_monitors.cf_project_name),
        sort_order = excluded.sort_order, status = excluded.status,
        config_revision = excluded.config_revision,
        last_checked_at = null, last_success_at = null, last_failure_at = null,
        last_status_code = null, last_raw_status_code = null, last_latency_ms = null,
        last_effective_reason = null, last_error = null, down_since = null,
        last_notified_at = null, updated_at = now();
    end loop;
  end if;

  if input_backup ? 'ping_tasks' and jsonb_typeof(input_backup->'ping_tasks') = 'array' then
    select coalesce(array_agg(id), array[]::bigint[]) into task_ids
    from (
      select (value->>'id')::bigint as id
      from jsonb_array_elements(input_backup->'ping_tasks')
      where coalesce(value->>'id', '') ~ '^[0-9]+$'
        and (value->>'id')::bigint > 0
    ) rows;

    lock table ping_tasks in share row exclusive mode;
    perform setval(pg_get_serial_sequence('ping_tasks', 'id'),
      greatest(
        coalesce((select max(id) from ping_tasks), 0) + 1,
        coalesce((select max(id) from unnest(task_ids) as restored(id)), 0) + 1,
        nextval(pg_get_serial_sequence('ping_tasks', 'id'))
      ), false);
    if coalesce(array_length(task_ids, 1), 0) > 0 then
      delete from ping_tasks where not (id = any(task_ids));
    else
      delete from ping_tasks where true;
    end if;

    for item in select value from jsonb_array_elements(input_backup->'ping_tasks')
    loop
      if coalesce(item->>'id', '') ~ '^[0-9]+$' and (item->>'id')::bigint > 0 then
        insert into ping_tasks (id, name, clients, all_clients, type, target, interval_sec, sort_order)
        values (
          (item->>'id')::bigint,
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          case when coalesce((item->>'all_clients')::boolean, false) then 1 else 0 end,
          coalesce(item->>'type', 'icmp'),
          coalesce(item->>'target', ''),
          coalesce((item->>'interval_sec')::integer, 120),
          coalesce((item->>'sort_order')::integer, (item->>'id')::integer)
        )
        on conflict (id) do update set
          name = excluded.name,
          clients = excluded.clients,
          all_clients = excluded.all_clients,
          type = excluded.type,
          target = excluded.target,
          interval_sec = excluded.interval_sec,
          sort_order = excluded.sort_order;
      else
        insert into ping_tasks (name, clients, all_clients, type, target, interval_sec, sort_order)
        values (
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          case when coalesce((item->>'all_clients')::boolean, false) then 1 else 0 end,
          coalesce(item->>'type', 'icmp'),
          coalesce(item->>'target', ''),
          coalesce((item->>'interval_sec')::integer, 120),
          coalesce((item->>'sort_order')::integer, 0)
        );
      end if;
    end loop;
  end if;

  if input_backup ? 'offline_notifications' and jsonb_typeof(input_backup->'offline_notifications') = 'array' then
    delete from offline_notifications where true;
    insert into offline_notifications (client, enable, grace_period, last_notified)
    select
      value->>'client',
      case when coalesce((value->>'enable')::boolean, false) then 1 else 0 end,
      coalesce((value->>'grace_period')::integer, 180),
      nullif(value->>'last_notified', '')::timestamptz
    from jsonb_array_elements(input_backup->'offline_notifications')
    where nullif(value->>'client', '') is not null;
  end if;

  if input_backup ? 'expiry_notifications' and jsonb_typeof(input_backup->'expiry_notifications') = 'array' then
    delete from expiry_notifications where true;
    insert into expiry_notifications (client, enable, advance_days, last_notified)
    select
      value->>'client',
      case when coalesce((value->>'enable')::boolean, false) then 1 else 0 end,
      coalesce((value->>'advance_days')::integer, 7),
      nullif(value->>'last_notified', '')::timestamptz
    from jsonb_array_elements(input_backup->'expiry_notifications')
    where nullif(value->>'client', '') is not null;
  end if;

  if input_backup ? 'load_notifications' and jsonb_typeof(input_backup->'load_notifications') = 'array' then
    lock table load_notifications in share row exclusive mode;
    perform setval(pg_get_serial_sequence('load_notifications', 'id'),
      greatest(
        coalesce((select max(id) from load_notifications), 0) + 1,
        coalesce((select max(case when coalesce(value->>'id', '') ~ '^[0-9]+$'
          then (value->>'id')::bigint else 0 end)
          from jsonb_array_elements(input_backup->'load_notifications')), 0) + 1,
        nextval(pg_get_serial_sequence('load_notifications', 'id'))
      ), false);
    delete from load_notifications where true;
    for item in select value from jsonb_array_elements(input_backup->'load_notifications')
    loop
      if coalesce(item->>'id', '') ~ '^[0-9]+$' and (item->>'id')::bigint > 0 then
        insert into load_notifications (id, name, clients, metric, threshold, ratio, interval_min, last_notified)
        values (
          (item->>'id')::bigint,
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          coalesce(item->>'metric', 'cpu'),
          coalesce((item->>'threshold')::double precision, 80),
          coalesce((item->>'ratio')::double precision, 0.8),
          coalesce((item->>'interval_min')::integer, 15),
          nullif(item->>'last_notified', '')::timestamptz
        );
      else
        insert into load_notifications (name, clients, metric, threshold, ratio, interval_min, last_notified)
        values (
          coalesce(item->>'name', ''),
          case when jsonb_typeof(item->'clients') = 'array' then item->'clients' else '[]'::jsonb end,
          coalesce(item->>'metric', 'cpu'),
          coalesce((item->>'threshold')::double precision, 80),
          coalesce((item->>'ratio')::double precision, 0.8),
          coalesce((item->>'interval_min')::integer, 15),
          nullif(item->>'last_notified', '')::timestamptz
        );
      end if;
    end loop;
  end if;
end;
$$;

revoke all on function public.cfm_restore_backup_data(jsonb) from public;
revoke all on function public.cfm_restore_backup_data(jsonb) from anon;
revoke all on function public.cfm_restore_backup_data(jsonb) from authenticated;
grant execute on function public.cfm_restore_backup_data(jsonb) to service_role;
