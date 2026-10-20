import type pg from 'pg';
import { afterAll, inject } from 'vitest';
import { createPool } from '../../src/server/db/client';
import { listStages } from '../../src/server/db/stages';

/** Pool connected as the DML-only app role (what the app uses at runtime). */
export function useAppPool(): pg.Pool {
  const pool = createPool(inject('appDbUrl'));
  afterAll(() => pool.end());
  return pool;
}

/** Superuser pool for fixtures the app role may not do (TRUNCATE, DDL checks). */
export function useAdminPool(): pg.Pool {
  const pool = createPool(inject('adminDbUrl'), 2);
  afterAll(() => pool.end());
  return pool;
}

export async function resetData(admin: pg.Pool): Promise<void> {
  await admin.query('truncate reviews, brands restart identity cascade');
}

export async function stageIdsByName(pool: pg.Pool): Promise<Record<string, number>> {
  const stages = await listStages(pool, { includeArchived: true });
  return Object.fromEntries(stages.map((s) => [s.name, s.id]));
}

export function pgErrorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}
