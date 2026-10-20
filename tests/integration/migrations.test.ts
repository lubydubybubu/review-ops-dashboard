import { mkdtemp, readFile, writeFile, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { listMigrationFiles, MIGRATIONS_DIR, runMigrations } from '../../src/server/db/migrate';
import { pgErrorCode, useAppPool } from './helpers';

async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: inject('adminDbUrl') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('migrations', () => {
  const app = useAppPool();

  it('recorded every migration file when run from zero', async () => {
    const files = await listMigrationFiles();
    const applied = await withAdmin((c) => c.query<{ filename: string }>('select filename from schema_migrations order by 1'));
    expect(applied.rows.map((r) => r.filename)).toEqual(files);
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const result = await withAdmin((c) => runMigrations(c));
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(await listMigrationFiles());
  });

  it('refuses to continue when an applied migration was edited', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mig-'));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const first = path.join(dir, (await listMigrationFiles(dir))[0]!);
    await writeFile(first, `${await readFile(first, 'utf8')}\n-- edited\n`);
    await expect(withAdmin((c) => runMigrations(c, { dir }))).rejects.toThrow(/was modified/);
  });

  it('runtime role cannot run DDL', async () => {
    await expect(app.query('create table should_fail (id int)')).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
    await expect(app.query('alter table reviews add column should_fail int')).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '42501',
    );
    await expect(app.query('drop table brands')).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
  });

  it('runtime role cannot change fixed categories or read the migration ledger', async () => {
    await expect(app.query(`delete from stage_categories where key = 'done'`)).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '42501',
    );
    await expect(app.query('select * from schema_migrations')).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
    const { rows } = await app.query<{ key: string }>('select key from stage_categories order by sort');
    expect(rows.map((r) => r.key)).toEqual(['todo', 'in_progress', 'done']);
  });

  it('runtime role is not a superuser', async () => {
    const { rows } = await app.query<{ rolsuper: boolean; rolcreatedb: boolean }>(
      'select rolsuper, rolcreatedb from pg_roles where rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolcreatedb: false });
  });
});
