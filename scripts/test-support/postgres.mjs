import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';

const migrations = new URL('../../supabase/migrations/', import.meta.url);

// 与 scripts/generate-migrations.mjs 保持同一套排序：编号两位数时按数字段排，
// 否则 10_/11_ 会插到 1_ 与 2_ 之间，后续 alter table 先于建表执行。
const migrationOrder = (a, b) => a.localeCompare(b, 'en', { numeric: true });

export async function applyApplicationMigrations(database) {
  const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort(migrationOrder);
  for (const file of files) {
    const sql = await readFile(new URL(file, migrations), 'utf8');
    await database.exec(`begin;\n${sql}\ncommit;`);
  }
}

export async function createTestDatabase({ migrate = true } = {}) {
  const database = new PGlite();
  try {
    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to service_role;
      alter default privileges in schema public grant all on sequences to service_role;
    `);
    if (migrate) await applyApplicationMigrations(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

export async function rpc(database, name, args = {}) {
  if (!/^cfm_[a-z0-9_]+$/.test(name)) throw new Error('Unexpected test RPC name');
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  for (const [key] of entries) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) throw new Error('Unexpected test argument name');
  }
  const parameters = entries.map(([key], index) => `${key} => $${index + 1}`).join(', ');
  const values = entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value);
  const result = await database.query(`select public.${name}(${parameters}) as result`, values);
  return result.rows[0].result;
}
