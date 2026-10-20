import 'server-only';
import { cache } from 'react';
import { requireSession } from './auth/session';
import { countPendingMail } from './db/mail';
import { getSettings } from './db/settings';
import { listStages } from './db/stages';
import { getPool } from './db/pool';
import { listViews } from './db/views';

/** Request-scoped loaders shared by layouts and pages (deduplicated per render); each checks the session itself. */
export const loadSettings = cache(async () => {
  await requireSession();
  return getSettings(getPool());
});
export const loadViews = cache(async () => {
  await requireSession();
  return listViews(getPool());
});
export const loadStages = cache(async () => {
  await requireSession();
  return listStages(getPool());
});
/** Pending mail requests (sidebar badge, dashboard line). */
export const loadMailPending = cache(async () => {
  await requireSession();
  return countPendingMail(getPool());
});
