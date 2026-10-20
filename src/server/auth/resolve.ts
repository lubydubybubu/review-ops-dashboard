import type { Queryable } from '../db/client';
import { ADMIN_SUBJECT, type AuthConfig } from './config';
import { HandoffError, TOKEN_RE, tokenHash, type SiteClient } from './handoff';
import { findSession, markValidated, revokeSession, type SessionMode } from './store';

export interface ActiveSession {
  id: number;
  mode: SessionMode;
  subject: string;
}

export type Resolution =
  | { status: 'valid'; session: ActiveSession }
  /** no cookie, unknown, expired or revoked */
  | { status: 'none' }
  /** was valid, ended now: site admin logout / password change / expiry / policy or mode change */
  | { status: 'ended' }
  /** the site could not be asked; fail closed without destroying the session */
  | { status: 'unavailable'; reason: string };

/**
 * The single server-side session check behind every page, action and route.
 *
 * site-mode sessions ride on a site grant that dies with the exact parent-site admin session it was
 * issued for (admin logout, password change / session-secret rotation, expiry) or with a policy
 * change on either side. A session whose last
 * back-channel check is older than `revalidateMs` re-asks the site before it is honored, so a
 * copied Ops cookie outlives a site logout by at most that window (0 = every request).
 */
export async function resolveSession(
  db: Queryable,
  config: AuthConfig,
  token: string | undefined,
  { site, now = new Date() }: { site?: SiteClient; now?: Date } = {},
): Promise<Resolution> {
  if (!token || !TOKEN_RE.test(token)) return { status: 'none' };
  const row = await findSession(db, tokenHash(token), now);
  if (!row) return { status: 'none' };

  const end = async (): Promise<Resolution> => {
    await revokeSession(db, row.id, now);
    return { status: 'ended' };
  };
  if (row.mode !== config.mode) return end();
  const session: ActiveSession = { id: row.id, mode: row.mode, subject: row.subject };
  if (config.mode === 'demo-password') return { status: 'valid', session };

  // Rows from the removed member identity (or anything else) end here.
  if (row.subject !== ADMIN_SUBJECT || !row.siteGrant) return end();
  const age = now.getTime() - new Date(row.validatedAt).getTime();
  if (config.revalidateMs > 0 && age >= 0 && age < config.revalidateMs) return { status: 'valid', session };

  if (!site) return { status: 'unavailable', reason: 'no-site-client' };
  try {
    const result = await site.introspect(row.siteGrant);
    if (!result.active || result.subject !== ADMIN_SUBJECT || result.identity !== config.site.identity) {
      return end();
    }
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof HandoffError ? error.tag : 'error' };
  }
  await markValidated(db, row.id, now);
  return { status: 'valid', session };
}
