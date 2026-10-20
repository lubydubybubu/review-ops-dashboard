import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

/**
 * Minimal migration runner: applies `NNN-name.sql` files in order, each in its own
 * transaction, and records filename + checksum in `schema_migrations`. An already
 * applied file whose content changed is an error (write a new migration instead).
 */

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../db/migrations');
const FILE_RE = /^(\d{3})-[a-z0-9-]+\.sql$/;
// arbitrary constant: serializes concurrent runners against the same database
const LOCK_KEY = 4_202_610_19;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function listMigrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set<string>();
  for (const file of files) {
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`migration file name must look like 001-name.sql: ${file}`);
    if (seen.has(m[1]!)) throw new Error(`duplicate migration number ${m[1]}`);
    seen.add(m[1]!);
  }
  return files;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function runMigrations(
  client: pg.ClientBase,
  { dir = MIGRATIONS_DIR, log = () => {} }: { dir?: string; log?: (line: string) => void } = {},
): Promise<MigrationResult> {
  await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename   text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'select filename, checksum from schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
    const result: MigrationResult = { applied: [], alreadyApplied: [] };

    for (const file of await listMigrationFiles(dir)) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const sum = checksum(sql);
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== sum) throw new Error(`migration ${file} was modified after it was applied`);
        result.alreadyApplied.push(file);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [file, sum]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
      result.applied.push(file);
      log(`applied ${file}`);
    }
    return result;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

/**
 * Least-privilege runtime role: DML on app tables only. No DDL (the role owns nothing),
 * fixed reference data is read-only, and the migrations ledger is not visible at all.
 */
export async function grantAppRole(client: pg.ClientBase, role: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error(`invalid role name: ${role}`);
  const r = client.escapeIdentifier(role);
  await client.query(`grant usage on schema public to ${r}`);
  await client.query(`grant select, insert, update, delete on all tables in schema public to ${r}`);
  await client.query(`grant usage, select on all sequences in schema public to ${r}`);
  await client.query(`revoke insert, update, delete on stage_categories from ${r}`);
  await client.query(`revoke all on schema_migrations from ${r}`);
}
