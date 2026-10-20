import 'server-only';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { createPool } from './client';

const globalForPool = globalThis as unknown as { opsPool?: pg.Pool };

/** DATABASE_URL, or the contents of DATABASE_URL_FILE (a mounted container secret). */
function databaseUrl(): string {
  const file = process.env.DATABASE_URL_FILE;
  const url = file ? readFileSync(file, 'utf8').trim() : process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

/** The app's shared pool (kept on globalThis so dev hot reloads don't leak connections). */
export function getPool(): pg.Pool {
  if (!globalForPool.opsPool) {
    globalForPool.opsPool = createPool(databaseUrl(), 10);
  }
  return globalForPool.opsPool;
}
