/**
 * npm run auth:revoke-all
 * Ends every Ops session now (e.g. after rotating the parent-site client secret or on suspicion).
 * Uses the runtime connection; needs only DML on auth_sessions.
 */
import { createPool } from '../src/server/db/client';
import { revokeAllSessions } from '../src/server/auth/store';
import { loadEnv, requireEnv } from './env';

loadEnv();
const pool = createPool(requireEnv('DATABASE_URL'), 1);
try {
  console.log(`revoked ${await revokeAllSessions(pool)} session(s)`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
