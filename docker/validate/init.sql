-- cf-vps-monitor 本地验证用初始化脚本。
-- 在 db 容器首次启动时以 POSTGRES_USER(postgres) 身份执行。
-- 目标：复刻 Supabase 的 service_role 权限模型 + 启用 pgcrypto 扩展
--（Supabase 默认启用 pgcrypto；原生 Postgres 镜像不启用，而迁移脚本用到 sha256()/gen_random_bytes()）。

-- 1) 迁移脚本用到的扩展
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2) 为 PostgREST 建立 authenticator / service_role 角色
--    PostgREST 以 authenticator 连接，再根据 JWT 的 role 声明 SET ROLE 到 service_role。
--    同时创建 Supabase 内置的 anon / authenticated 角色（迁移 4 会对它们做 revoke，
--    原生 Postgres 没有这两个角色，必须显式创建才能套用迁移）。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'authenticator';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

-- 3) authenticator 必须能切换到 service_role
GRANT service_role TO authenticator;

-- 4) service_role 在 public schema 上的默认授权（覆盖迁移脚本随后创建的对象）
GRANT USAGE ON SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TYPES TO service_role;

-- 注：迁移脚本会把表授权给 cf_monitor_app、把函数 EXECUTE 授权给 service_role；
-- 上面的默认授权保证 service_role 对“迁移创建的所有对象”都有完整权限，
-- 与 Supabase 上 service_role（继承 postgres）的行为一致。
