-- 迁移应用后的兜底授权：确保 service_role 对 public schema 下所有对象都有完整权限。
-- 与 Supabase 上 service_role（继承 postgres）的行为一致。幂等，可重复执行。
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL TYPES IN SCHEMA public TO service_role;
ALTER ROLE service_role BYPASSRLS;
