/**
 * npm run db:seed [-- --reset]
 * Fills an empty database with fictional DEMO data. --reset wipes reviews and brands first
 * (needs TRUNCATE, so it uses MIGRATION_DATABASE_URL when set).
 */
import { todayInSeoul } from '../src/lib/domain/dates';
import { createPool } from '../src/server/db/client';
import { seedDemo } from '../src/server/db/seed';
import { loadEnv, requireEnv } from './env';

loadEnv();
if (process.env.OPS_DEPLOYMENT === 'production') {
  console.error('db:seed writes fictional demo data and is refused when OPS_DEPLOYMENT=production.');
  process.exit(1);
}
const pool = createPool(requireEnv('MIGRATION_DATABASE_URL', 'DATABASE_URL'));
try {
  if (process.argv.includes('--reset')) {
    await pool.query('truncate reviews, brands restart identity cascade');
    console.log('reset: reviews and brands removed');
  }
  const result = await seedDemo(pool, todayInSeoul());
  console.log(`seeded ${result.brands} demo brands and ${result.reviews} demo reviews`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
