import { getPool } from '@/server/db/pool';

export const dynamic = 'force-dynamic';

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

/**
 * Container healthcheck: process up and the database answering. Unauthenticated, so the body
 * is a fixed word — no versions, errors, hostnames or counts.
 */
export async function GET() {
  try {
    await Promise.race([
      getPool().query('select 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref()),
    ]);
    return new Response('{"status":"ok"}', { status: 200, headers: HEADERS });
  } catch {
    return new Response('{"status":"unavailable"}', { status: 503, headers: HEADERS });
  }
}
