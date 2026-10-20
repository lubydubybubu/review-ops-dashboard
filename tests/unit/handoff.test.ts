import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SiteAuthConfig } from '../../src/server/auth/config';
import {
  authorizeUrl,
  createSiteClient,
  HandoffError,
  isTrustedOrigin,
  pkceChallenge,
  randomToken,
  safeReturnTo,
  TOKEN_RE,
  tokenHash,
} from '../../src/server/auth/handoff';
import { ADMIN_SUBJECT, CLIENT_ID, startFakeSite, type FakeSite } from '../fixtures/fake-site';

async function tagOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof HandoffError ? error.tag : `other:${(error as Error).name}`;
  }
}

describe('handoff primitives', () => {
  it('random tokens are 256-bit base64url and unique', () => {
    const a = randomToken();
    expect(TOKEN_RE.test(a)).toBe(true);
    expect(a).not.toBe(randomToken());
    expect(tokenHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('PKCE S256 matches RFC 7636 appendix B', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('safeReturnTo blocks open redirects and auth loops', () => {
    for (const bad of [
      'https://evil.example',
      '//evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
      '/auth/callback?code=x',
      '/login',
      '/a\u0000b',
      `/${'x'.repeat(600)}`,
      undefined,
      42,
    ]) {
      expect(safeReturnTo(bad)).toBe('/');
    }
    // percent-encoded CR/LF stays an encoded in-app path; it never becomes a header
    expect(safeReturnTo('/%0d%0aSet-Cookie:x')).toBe('/%0d%0aSet-Cookie:x');
    expect(safeReturnTo('/board?view=week')).toBe('/board?view=week');
  });

  it('mutation origin check (CSRF): exact Ops origin or same-origin metadata only', () => {
    const h = (entries: Record<string, string>) => new Headers(entries);
    const ops = 'https://ops.example.test';
    expect(isTrustedOrigin(h({ origin: ops }), ops)).toBe(true);
    expect(isTrustedOrigin(h({ origin: 'https://evil.example' }), ops)).toBe(false);
    expect(isTrustedOrigin(h({ origin: 'https://site.example.test' }), ops)).toBe(false); // even the sibling site
    expect(isTrustedOrigin(h({ origin: 'null' }), ops)).toBe(false);
    expect(isTrustedOrigin(h({ origin: ops, 'sec-fetch-site': 'cross-site' }), ops)).toBe(false);
    expect(isTrustedOrigin(h({ 'sec-fetch-site': 'same-origin' }), ops)).toBe(true);
    expect(isTrustedOrigin(h({ 'sec-fetch-site': 'same-site' }), ops)).toBe(false);
    expect(isTrustedOrigin(h({}), ops)).toBe(false);
  });

  it('authorize URL carries only state + S256 challenge to the exact site path', () => {
    const config = {
      mode: 'site',
      publicOrigin: 'https://ops.example.test',
      site: { origin: 'https://site.example.test', clientId: 'review-ops' },
    } as SiteAuthConfig;
    const url = new URL(authorizeUrl(config, { state: 'S'.repeat(43), challenge: 'C'.repeat(43) }));
    expect(url.origin).toBe('https://site.example.test');
    expect(url.pathname).toBe('/admin/ops-handoff/');
    expect(url.searchParams.get('redirect_uri')).toBe('https://ops.example.test/auth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect([...url.searchParams.keys()].sort().join(',')).toBe('client_id,code_challenge,code_challenge_method,redirect_uri,state');
  });
});

describe('site back-channel client (against the synthetic parent-site service)', () => {
  let site: FakeSite;
  const redirectUri = 'https://ops.example.test/auth/callback';
  const client = (overrides: { secret?: string; timeoutMs?: number } = {}) =>
    createSiteClient({
      origin: site.origin,
      clientId: CLIENT_ID,
      clientSecret: overrides.secret ?? site.clientSecret,
      identity: 'admin',
      timeoutMs: overrides.timeoutMs ?? 1000,
    });
  const freshCode = () => {
    const verifier = randomToken();
    return { verifier, ...site.issueCodeFor(pkceChallenge(verifier)) };
  };

  beforeAll(async () => {
    site = await startFakeSite();
    site.setRedirectUri(redirectUri);
  });
  afterAll(() => site.close());
  beforeEach(() => {
    site.misbehave('none');
  });

  it('exchanges a code once; the grant introspects active, then inactive after revoke', async () => {
    const { verifier, code } = freshCode();
    const grant = await client().exchange({ code, verifier, redirectUri });
    expect(grant.subject).toBe(ADMIN_SUBJECT);
    expect(grant.identity).toBe('admin');
    expect((await client().introspect(grant.grant)).active).toBe(true);
    await client().revoke(grant.grant);
    expect((await client().introspect(grant.grant)).active).toBe(false);
  });

  it('replay: a second redemption fails and kills the grant from the first', async () => {
    const { verifier, code } = freshCode();
    const grant = await client().exchange({ code, verifier, redirectUri });
    expect(await tagOf(client().exchange({ code, verifier, redirectUri }))).toBe('invalid_grant');
    expect((await client().introspect(grant.grant)).active).toBe(false);
  });

  it('concurrent double redemption: exactly one succeeds', async () => {
    const { verifier, code } = freshCode();
    const results = await Promise.allSettled([
      client().exchange({ code, verifier, redirectUri }),
      client().exchange({ code, verifier, redirectUri }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
  });

  it('wrong PKCE verifier or redirect URI is refused', async () => {
    const a = freshCode();
    expect(await tagOf(client().exchange({ code: a.code, verifier: randomToken(), redirectUri }))).toBe('invalid_grant');
    const b = freshCode();
    expect(await tagOf(client().exchange({ code: b.code, verifier: b.verifier, redirectUri: 'https://ops.example.test/other' }))).toBe('invalid_grant');
  });

  it('wrong client secret is invalid_client (no detail leaks)', async () => {
    const { verifier, code } = freshCode();
    expect(await tagOf(client({ secret: 'w'.repeat(40) }).exchange({ code, verifier, redirectUri }))).toBe('invalid_client');
  });

  it('an admin logout between issue and redeem makes the code useless', async () => {
    const { verifier, code, adminToken } = freshCode();
    site.adminLogout(adminToken);
    expect(await tagOf(client().exchange({ code, verifier, redirectUri }))).toBe('invalid_grant');
  });

  it('site admin logout deactivates the grant of that admin session', async () => {
    const { verifier, code, adminToken } = freshCode();
    const grant = await client().exchange({ code, verifier, redirectUri });
    expect((await client().introspect(grant.grant)).active).toBe(true);
    site.adminLogout(adminToken);
    expect((await client().introspect(grant.grant)).active).toBe(false);
  });

  it('admin password change (session secret rotation) deactivates every grant', async () => {
    const a = freshCode();
    const b = freshCode();
    const ga = await client().exchange({ code: a.code, verifier: a.verifier, redirectUri });
    const gb = await client().exchange({ code: b.code, verifier: b.verifier, redirectUri });
    site.changeAdminPassword();
    expect((await client().introspect(ga.grant)).active).toBe(false);
    expect((await client().introspect(gb.grant)).active).toBe(false);
  });

  it('times out instead of hanging', async () => {
    site.misbehave('slow');
    const started = Date.now();
    expect(await tagOf(client({ timeoutMs: 500 }).introspect(randomToken()))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1400);
  });

  it('refuses redirects, oversize bodies, non-JSON and server errors', async () => {
    site.misbehave('redirect');
    expect(['redirect', 'transport']).toContain(await tagOf(client().introspect(randomToken())));
    site.misbehave('oversize');
    expect(await tagOf(client().introspect(randomToken()))).toBe('size');
    site.misbehave('html');
    expect(await tagOf(client().introspect(randomToken()))).toBe('content-type');
    site.misbehave('error500');
    expect(await tagOf(client().introspect(randomToken()))).toBe('status_500');
  });

  it('rejects a response that does not match the protocol schema', async () => {
    const fake = (body: unknown) =>
      createSiteClient(
        { origin: 'https://site.example.test', clientId: 'x-y-z', clientSecret: 'q'.repeat(40), identity: 'admin', timeoutMs: 500 },
        { fetch: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) },
      );
    expect(await tagOf(fake({ active: true, subject: 'someone-else', identity: 'admin', expires_at: 1 }).introspect('g'))).toBe('schema');
    // the removed member identity is never accepted, whatever the site says
    expect(await tagOf(fake({ active: true, subject: ADMIN_SUBJECT, identity: 'member', expires_at: 1 }).introspect('g'))).toBe('schema');
    expect(await tagOf(fake({ active: true, subject: 'member-subject-1', identity: 'member', expires_at: 1 }).introspect('g'))).toBe('schema');
    expect(await tagOf(fake({ active: true, subject: ADMIN_SUBJECT, identity: 'admin', expires_at: 1 }).introspect('g'))).toBe('resolved');
  });

  it('sends client_secret_basic and never puts the secret in the URL or body', async () => {
    let seen: { url: string; body: string; auth: string } | undefined;
    const secret = 'z'.repeat(40);
    const spy = createSiteClient(
      { origin: 'https://site.example.test', clientId: 'x-y-z', clientSecret: secret, identity: 'admin', timeoutMs: 500 },
      {
        fetch: async (url, init) => {
          seen = { url, body: String(init.body), auth: String((init.headers as Record<string, string>).authorization) };
          expect(init.redirect).toBe('error');
          return new Response('{"active":false}', { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    );
    await spy.introspect('g'.repeat(43));
    expect(seen!.url).toBe('https://site.example.test/api/ops-handoff/introspect');
    expect(seen!.url.includes(secret) || seen!.body.includes(secret)).toBe(false);
    expect(Buffer.from(seen!.auth.replace('Basic ', ''), 'base64').toString()).toBe(`x-y-z:${secret}`);
  });
});
