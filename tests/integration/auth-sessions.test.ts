import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_SUBJECT, type DemoAuthConfig, type SiteAuthConfig } from '../../src/server/auth/config';
import { HandoffError, randomToken, tokenHash, type Introspection, type SiteClient } from '../../src/server/auth/handoff';
import { resolveSession } from '../../src/server/auth/resolve';
import {
  consumeLoginAttempt,
  createLoginAttempt,
  createSession,
  findSession,
  LOGIN_ATTEMPT_TTL_MS,
  MAX_PENDING_ATTEMPTS,
  MAX_SESSIONS_PER_SUBJECT,
  revokeAllSessions,
  revokeSession,
} from '../../src/server/auth/store';
import { useAdminPool, useAppPool } from './helpers';

const ADMIN = ADMIN_SUBJECT;
const T0 = new Date('2026-10-19T03:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const siteMode: SiteAuthConfig = {
  mode: 'site',
  publicOrigin: 'https://ops.example.test',
  secureCookies: true,
  sessionTtlMs: 12 * 3600_000,
  revalidateMs: 30_000,
  site: { origin: 'https://site.example.test', clientId: 'review-ops', clientSecret: 'x'.repeat(40), identity: 'admin', timeoutMs: 500 },
};
const demo: DemoAuthConfig = { mode: 'demo-password', publicOrigin: 'http://127.0.0.1:3000', secureCookies: false, sessionTtlMs: 3600_000, passwordHash: 'scrypt:1:1:1:a:b' };

/** Scripted stand-in for the site back channel. */
function scriptedSite(answer: () => Introspection | 'down') {
  const calls = { introspect: 0 };
  const site: SiteClient = {
    async exchange() {
      throw new Error('unused');
    },
    async introspect() {
      calls.introspect++;
      const a = answer();
      if (a === 'down') throw new HandoffError('timeout');
      return a;
    },
    async revoke() {},
  };
  return { site, calls };
}

describe('auth: login attempts (state / PKCE verifier store)', () => {
  const app = useAppPool();
  const admin = useAdminPool();
  beforeEach(async () => {
    await admin.query('truncate auth_login_attempts, auth_sessions restart identity');
  });

  const attempt = () => {
    const state = randomToken();
    const binding = randomToken();
    return { state, binding, row: { stateHash: tokenHash(state), bindingHash: tokenHash(binding), verifier: randomToken(), returnTo: '/board' } };
  };

  it('stores only hashes of state and binding', async () => {
    const a = attempt();
    expect(await createLoginAttempt(app, a.row, T0)).toBe(true);
    const { rows } = await app.query<{ state_hash: string }>('select state_hash from auth_login_attempts');
    expect(rows[0]!.state_hash).toBe(tokenHash(a.state));
    expect(rows[0]!.state_hash.includes(a.state)).toBe(false);
  });

  it('is one-use: the second callback with the same state gets nothing', async () => {
    const a = attempt();
    await createLoginAttempt(app, a.row, T0);
    const first = await consumeLoginAttempt(app, a.row.stateHash, a.row.bindingHash, at(1000));
    expect(first?.verifier).toBe(a.row.verifier);
    expect(first?.returnTo).toBe('/board');
    expect(await consumeLoginAttempt(app, a.row.stateHash, a.row.bindingHash, at(2000))).toBeNull();
  });

  it('needs the same browser binding, and a wrong binding burns the state (login CSRF)', async () => {
    const a = attempt();
    await createLoginAttempt(app, a.row, T0);
    expect(await consumeLoginAttempt(app, a.row.stateHash, tokenHash(randomToken()), at(1000))).toBeNull();
    expect(await consumeLoginAttempt(app, a.row.stateHash, a.row.bindingHash, at(1000))).toBeNull();
  });

  it('expires after the attempt TTL', async () => {
    const a = attempt();
    await createLoginAttempt(app, a.row, T0);
    expect(await consumeLoginAttempt(app, a.row.stateHash, a.row.bindingHash, at(LOGIN_ATTEMPT_TTL_MS + 1))).toBeNull();
  });

  it('concurrent callbacks with one state: exactly one wins', async () => {
    const a = attempt();
    await createLoginAttempt(app, a.row, T0);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => consumeLoginAttempt(app, a.row.stateHash, a.row.bindingHash, at(500))),
    );
    expect(results.filter(Boolean).length).toBe(1);
  });

  it('is bounded: refuses new attempts at the cap, prunes expired ones', async () => {
    for (let i = 0; i < MAX_PENDING_ATTEMPTS; i++) expect(await createLoginAttempt(app, attempt().row, T0)).toBe(true);
    expect(await createLoginAttempt(app, attempt().row, at(1000))).toBe(false);
    expect(await createLoginAttempt(app, attempt().row, at(LOGIN_ATTEMPT_TTL_MS + 1))).toBe(true);
    const { rows } = await app.query<{ n: number }>('select count(*)::int as n from auth_login_attempts');
    expect(rows[0]!.n).toBe(1);
  });
});

describe('auth: server-side sessions', () => {
  const app = useAppPool();
  const admin = useAdminPool();
  beforeEach(async () => {
    await admin.query('truncate auth_login_attempts, auth_sessions restart identity');
  });

  async function siteSession(expiresIn = 3600_000) {
    const token = randomToken();
    const id = await createSession(app, { tokenHash: tokenHash(token), mode: 'site', subject: ADMIN, siteGrant: randomToken(), expiresAt: at(expiresIn) }, T0);
    return { token, id };
  }

  it('the cookie value is never stored; only its hash', async () => {
    const { token } = await siteSession();
    const { rows } = await app.query<{ token_hash: string }>('select token_hash from auth_sessions');
    expect(rows[0]!.token_hash).toBe(tokenHash(token));
  });

  it('unknown, malformed, expired and revoked sessions resolve to none', async () => {
    const { site } = scriptedSite(() => ({ active: true, subject: ADMIN, identity: 'admin', expiresAt: 0 }));
    expect((await resolveSession(app, siteMode, undefined, { site, now: T0 })).status).toBe('none');
    expect((await resolveSession(app, siteMode, 'not a token', { site, now: T0 })).status).toBe('none');
    expect((await resolveSession(app, siteMode, randomToken(), { site, now: T0 })).status).toBe('none');
    const a = await siteSession(60_000);
    expect((await resolveSession(app, siteMode, a.token, { site, now: at(60_001) })).status).toBe('none');
    const b = await siteSession();
    await revokeSession(app, b.id, at(1));
    expect((await resolveSession(app, siteMode, b.token, { site, now: at(2) })).status).toBe('none');
  });

  it('within the revalidation window no site call is made; after it the grant is re-checked', async () => {
    const { site, calls } = scriptedSite(() => ({ active: true, subject: ADMIN, identity: 'admin', expiresAt: 0 }));
    const { token } = await siteSession();
    expect((await resolveSession(app, siteMode, token, { site, now: at(10_000) })).status).toBe('valid');
    expect(calls.introspect).toBe(0);
    expect((await resolveSession(app, siteMode, token, { site, now: at(30_000) })).status).toBe('valid');
    expect(calls.introspect).toBe(1);
    // validated_at moved forward: the next 30 s are free again
    expect((await resolveSession(app, siteMode, token, { site, now: at(45_000) })).status).toBe('valid');
    expect(calls.introspect).toBe(1);
  });

  it('site admin logout / password change (grant inactive) ends the session; a copied cookie is dead too', async () => {
    let active = true;
    const { site } = scriptedSite(() => (active ? { active: true, subject: ADMIN, identity: 'admin', expiresAt: 0 } : { active: false }));
    const { token, id } = await siteSession();
    const copied = token; // e.g. lifted from another browser
    active = false;
    expect((await resolveSession(app, siteMode, token, { site, now: at(31_000) })).status).toBe('ended');
    expect((await resolveSession(app, siteMode, copied, { site, now: at(31_001) })).status).toBe('none');
    const { rows } = await app.query<{ revoked: boolean }>('select revoked_at is not null as revoked from auth_sessions where id = $1', [id]);
    expect(rows[0]!.revoked).toBe(true);
  });

  it('revalidateMs = 0 asks the site on every request', async () => {
    const { site, calls } = scriptedSite(() => ({ active: true, subject: ADMIN, identity: 'admin', expiresAt: 0 }));
    const { token } = await siteSession();
    for (let i = 1; i <= 3; i++) await resolveSession(app, { ...siteMode, revalidateMs: 0 }, token, { site, now: at(i) });
    expect(calls.introspect).toBe(3);
  });

  it('site unreachable fails closed without destroying the session', async () => {
    let down = true;
    const { site } = scriptedSite(() => (down ? 'down' : { active: true, subject: ADMIN, identity: 'admin', expiresAt: 0 }));
    const { token } = await siteSession();
    const r = await resolveSession(app, siteMode, token, { site, now: at(31_000) });
    expect(r.status).toBe('unavailable');
    expect(r.status === 'unavailable' && r.reason).toBe('timeout');
    down = false;
    expect((await resolveSession(app, siteMode, token, { site, now: at(32_000) })).status).toBe('valid');
  });

  it('a different subject or identity from the site ends the session', async () => {
    const { site } = scriptedSite(() => ({ active: true, subject: 'someone-else', identity: 'admin', expiresAt: 0 }));
    const a = await siteSession();
    expect((await resolveSession(app, siteMode, a.token, { site, now: at(31_000) })).status).toBe('ended');
    const member = scriptedSite(() => ({ active: true, subject: ADMIN, identity: 'member' as 'admin', expiresAt: 0 }));
    const b = await siteSession();
    expect((await resolveSession(app, siteMode, b.token, { site: member.site, now: at(31_000) })).status).toBe('ended');
  });

  it('a session row from the removed member identity ends on its next request, without asking the site', async () => {
    const { site, calls } = scriptedSite(() => ({ active: true, subject: ADMIN, identity: 'admin', expiresAt: 0 }));
    const token = randomToken();
    await createSession(app, { tokenHash: tokenHash(token), mode: 'site', subject: 'member-subject-1', siteGrant: randomToken(), expiresAt: at(3600_000) }, T0);
    expect((await resolveSession(app, siteMode, token, { site, now: at(1) })).status).toBe('ended');
    expect(calls.introspect).toBe(0);
  });

  it('switching OPS_AUTH_MODE ends sessions of the other mode (demo sessions never work in site mode)', async () => {
    const token = randomToken();
    await createSession(app, { tokenHash: tokenHash(token), mode: 'demo-password', subject: 'demo-owner', siteGrant: null, expiresAt: at(3600_000) }, T0);
    expect((await resolveSession(app, demo, token, { now: at(1) })).status).toBe('valid');
    expect((await resolveSession(app, siteMode, token, { now: at(2) })).status).toBe('ended');
    expect((await resolveSession(app, demo, token, { now: at(3) })).status).toBe('none');
  });

  it('keeps at most N live sessions per subject (oldest revoked)', async () => {
    const tokens: string[] = [];
    for (let i = 0; i < MAX_SESSIONS_PER_SUBJECT + 2; i++) {
      const token = randomToken();
      tokens.push(token);
      await createSession(app, { tokenHash: tokenHash(token), mode: 'site', subject: ADMIN, siteGrant: randomToken(), expiresAt: at(3600_000) }, at(i * 1000));
    }
    const now = at(20_000);
    expect(await findSession(app, tokenHash(tokens[0]!), now)).toBeNull();
    expect(await findSession(app, tokenHash(tokens[1]!), now)).toBeNull();
    expect(await findSession(app, tokenHash(tokens.at(-1)!), now)).not.toBeNull();
    const { rows } = await app.query<{ n: number }>('select count(*)::int as n from auth_sessions where revoked_at is null');
    expect(rows[0]!.n).toBe(MAX_SESSIONS_PER_SUBJECT);
  });

  it('revoke-all (e.g. after rotating the client secret) ends every session', async () => {
    const a = await siteSession();
    const b = await siteSession();
    expect(await revokeAllSessions(app, at(1))).toBe(2);
    expect(await findSession(app, tokenHash(a.token), at(2))).toBeNull();
    expect(await findSession(app, tokenHash(b.token), at(2))).toBeNull();
  });

  it('DB constraints: site-mode sessions need a grant, demo sessions must not have one', async () => {
    await expect(
      createSession(app, { tokenHash: tokenHash(randomToken()), mode: 'site', subject: ADMIN, siteGrant: null, expiresAt: at(1000) }, T0),
    ).rejects.toThrow();
    await expect(
      createSession(app, { tokenHash: tokenHash(randomToken()), mode: 'demo-password', subject: 'x', siteGrant: randomToken(), expiresAt: at(1000) }, T0),
    ).rejects.toThrow();
  });
});
