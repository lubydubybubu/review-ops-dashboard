/**
 * npm run db:migrate [-- --grant <app_role>]
 * Applies pending migrations using MIGRATION_DATABASE_URL (falls back to DATABASE_URL).
 * With --grant, (re)grants DML-only privileges to the runtime role afterwards.
 */
import pg from 'pg';
import { grantAppRole, runMigrations } from '../src/server/db/migrate';
import { loadEnv, requireEnv } from './env';

loadEnv();
const url = requireEnv('MIGRATION_DATABASE_URL', 'DATABASE_URL');
const grantIndex = process.argv.indexOf('--grant');
const grantRole = grantIndex > -1 ? process.argv[grantIndex + 1] : undefined;

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const result = await runMigrations(client, { log: (line) => console.log(line) });
  console.log(`migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already applied`);
  if (grantRole) {
    await grantAppRole(client, grantRole);
    console.log(`granted DML privileges to ${grantRole}`);
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
