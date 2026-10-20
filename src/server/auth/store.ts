import type { Queryable } from '../db/client';

/**
 * Sign-in state in PostgreSQL. Times are passed in (not `now()`) so tests can move the clock.
 * Every table is bounded: expired rows are pruned on write and live rows are capped.
 */

export const LOGIN_ATTEMPT_TTL_MS = 5 * 60_000;
export const MAX_PENDING_ATTEMPTS = 50;
export const MAX_SESSIONS_PER_SUBJECT = 10;

export interface LoginAttempt {
  stateHash: string;
  bindingHash: string;
  verifier: string;
  returnTo: string;
}

/** false when too many sign-ins are already pending (fail closed, no eviction of live rows). */
export async function createLoginAttempt(db: Queryable, attempt: LoginAttempt, now = new Date()): Promise<boolean> {
  await db.query('delete from auth_login_attempts where expires_at <= $1', [now]);
  const { rows } = await db.query<{ inserted: boolean }>(
    `insert into auth_login_attempts (state_hash, binding_hash, code_verifier, return_to, created_at, expires_at)
     select $1, $2, $3, $4, $5, $6
      where (select count(*) from auth_login_attempts) < $7
     returning true as inserted`,
    [
      attempt.stateHash,
      attempt.bindingHash,
      attempt.verifier,
      attempt.returnTo,
      now,
      new Date(now.getTime() + LOGIN_ATTEMPT_TTL_MS),
      MAX_PENDING_ATTEMPTS,
    ],
  );
  return rows.length === 1;
}

/**
 * One-use: the row is deleted in the same statement that reads it, so of two concurrent
 * callbacks with the same state exactly one gets the verifier. Needs the matching browser
 * binding too, so a state lifted from someone else's URL is useless.
 */
export async function consumeLoginAttempt(
  db: Queryable,
  stateHash: string,
  bindingHash: string,
  now = new Date(),
): Promise<{ verifier: string; returnTo: string } | null> {
  const { rows } = await db.query<{ code_verifier: string; return_to: string; binding_hash: string; live: boolean }>(
    'delete from auth_login_attempts where state_hash = $1 returning code_verifier, return_to, binding_hash, expires_at > $2 as live',
    [stateHash, now],
  );
  const row = rows[0];
  // A wrong binding still burns the state: an attacker who saw it cannot retry.
  if (!row || !row.live || row.binding_hash !== bindingHash) return null;
  return { verifier: row.code_verifier, returnTo: row.return_to };
}

export type SessionMode = 'site' | 'demo-password';

export interface SessionRow {
  id: number;
  mode: SessionMode;
  subject: string;
  siteGrant: string | null;
  expiresAt: string;
  validatedAt: string;
}

export async function createSession(
  db: Queryable,
  input: { tokenHash: string; mode: SessionMode; subject: string; siteGrant: string | null; expiresAt: Date },
  now = new Date(),
): Promise<number> {
  await db.query('delete from auth_sessions where expires_at <= $1 or revoked_at <= $1', [new Date(now.getTime() - 60_000)]);
  // Keep at most N live sessions per subject: revoke the oldest beyond the cap.
  await db.query(
    `update auth_sessions set revoked_at = $2
      where id in (select id from auth_sessions
                    where subject = $1 and revoked_at is null and expires_at > $2
                    order by created_at desc, id desc offset $3)`,
    [input.subject, now, MAX_SESSIONS_PER_SUBJECT - 1],
  );
  const { rows } = await db.query<{ id: number }>(
    `insert into auth_sessions (token_hash, mode, subject, site_grant, created_at, expires_at, validated_at)
     values ($1, $2, $3, $4, $5, $6, $5) returning id`,
    [input.tokenHash, input.mode, input.subject, input.siteGrant, now, input.expiresAt],
  );
  return rows[0]!.id;
}

export async function findSession(db: Queryable, tokenHash: string, now = new Date()): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `select id, mode, subject, site_grant as "siteGrant", expires_at as "expiresAt", validated_at as "validatedAt"
       from auth_sessions where token_hash = $1 and revoked_at is null and expires_at > $2`,
    [tokenHash, now],
  );
  return rows[0] ?? null;
}

export async function markValidated(db: Queryable, id: number, now = new Date()): Promise<void> {
  await db.query('update auth_sessions set validated_at = $2 where id = $1 and revoked_at is null', [id, now]);
}

/** Revoke one session; returns its site grant (so the caller can revoke it upstream too). */
export async function revokeSession(db: Queryable, id: number, now = new Date()): Promise<string | null> {
  const { rows } = await db.query<{ site_grant: string | null }>(
    'update auth_sessions set revoked_at = $2 where id = $1 and revoked_at is null returning site_grant',
    [id, now],
  );
  return rows[0]?.site_grant ?? null;
}

export async function revokeAllSessions(db: Queryable, now = new Date()): Promise<number> {
  const { rowCount } = await db.query('update auth_sessions set revoked_at = $1 where revoked_at is null', [now]);
  return rowCount ?? 0;
}
