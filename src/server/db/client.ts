import pg from 'pg';

/** Anything that can run a query: a Pool, or a checked-out client inside a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** A Queryable that can also open a transaction (i.e. a Pool). */
export interface Database extends Queryable {
  connect(): Promise<pg.PoolClient>;
}

const OID = { int8: 20, date: 1082, timestamp: 1114, timestamptz: 1184 } as const;

/**
 * Per-pool type parsers (not the global `pg.types`):
 * - `date` stays a `YYYY-MM-DD` string — it is a KST calendar day, never a JS Date at midnight local.
 * - `timestamptz` becomes an ISO-8601 UTC string so values serialize cleanly to the client.
 * - `int8` (identity ids, counts) becomes a number; ids stay far below 2^53.
 */
const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === OID.date) return (v: string) => v;
    if (oid === OID.timestamptz) return (v: string) => new Date(v).toISOString();
    if (oid === OID.int8) return (v: string) => Number(v);
    return pg.types.getTypeParser(oid, format);
  }) as pg.CustomTypesConfig['getTypeParser'],
};

export function createPool(connectionString: string, max = 5): pg.Pool {
  const pool = new pg.Pool({
    connectionString, max, types, idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
    query_timeout: 20_000,
  });
  // pg-pool removes the failed idle client itself. Do not log the Error/client (credentials).
  pool.on('error', () => console.error('db: idle connection lost'));
  return pool;
}

/** Run `fn` in a transaction on its own client; rolls back on any error. */
export async function withTransaction<T>(db: Database, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Escape a user string for use inside an ILIKE pattern (the value is still a bind parameter). */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
