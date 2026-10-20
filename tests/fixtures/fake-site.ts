/**
 * Synthetic stand-in for the parent site's side of the Ops handoff (docs/AUTH.md), for tests
 * only. Generated secrets, loopback only. It follows the site-side contract in docs/AUTH.md:
 * the handoff page lives under /admin/ and needs the ADMIN session (no admin session →
 * 302 to the admin login page, like every /admin page; a member/Discord cookie counts for
 * nothing), the admin cookie is `__Host-…; Secure; HttpOnly; SameSite=Strict`, the Ops origin
 * must be same-site, the page answers GET only and a valid request gets a 303 with the code at
 * once, invalid requests are never redirected, codes are
 * one-use and 60 s, PKCE S256, a replay revokes the grant, and a grant lives only as long as the
 * exact admin session it came from (logout, password change = secret rotation, expiry).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

export const CLIENT_ID = 'review-ops-test';
export const ADMIN_SUBJECT = 'site-admin';
export const ADMIN_COOKIE = '__Host-site_admin';
export const MEMBER_COOKIE = '__Host-site_member';
const PAGE = '/admin/ops-handoff/';
const LOGIN = '/admin/login.html';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const rand = () => randomBytes(32).toString('base64url');
/** Registrable-domain stand-in: last two labels (IPs / single labels must match exactly). */
const siteOf = (host: string) => (/^[\d.]+$|^[^.]*$/.test(host) ? host : host.split('.').slice(-2).join('.'));

export type Misbehavior = 'none' | 'redirect' | 'oversize' | 'html' | 'slow' | 'error500';

/** What the browser E2E needs from a site implementation (this fake, or any other implementation of the contract). */
export interface SiteFixture {
  /** Which implementation answers (printed by the E2E). */
  kind: string;
  /** Browser-visible origin, e.g. https://site.test:PORT */
  origin: string;
  clientId: string;
  clientSecret: string;
  adminEmail: string;
  /** Current admin password (changes after changeAdminPassword). */
  readonly adminPassword: string;
  /** GET here signs the browser in as a joined Discord member (no admin session). */
  memberLoginPath: string;
  /** Point the handoff at this Ops callback (exact match). */
  setRedirectUri(uri: string): void;
  misbehave(mode: Misbehavior): void;
  /** Admin password change on the site: the session secret rotates, so every admin session ends. */
  changeAdminPassword(): void;
  /** Ask the back channel about a grant, exactly as Ops does. */
  grantActive(grant: string): Promise<boolean>;
  counts(): { introspections: number };
  close(): Promise<void>;
}

export interface FakeSite extends SiteFixture {
  /** Server-side helper for transport tests that skip the browser: a fresh admin session + code. */
  issueCodeFor(challenge: string): { code: string; adminToken: string };
  /** Admin logout of one session (revocation), or of all of them. */
  adminLogout(adminToken?: string): void;
}

interface Code {
  session: string;
  challenge: string;
  redirect: string;
  expires: number;
  used: boolean;
  grant?: string;
}

export interface FakeSiteOptions {
  /** https with this key/cert (browser E2E); plain http otherwise. */
  tls?: { key: string; cert: string };
  /** Hostname the browser uses; the server always listens on 127.0.0.1. */
  hostname?: string;
}

export async function startFakeSite({ tls, hostname = '127.0.0.1' }: FakeSiteOptions = {}): Promise<FakeSite> {
  const clientSecret = rand();
  const adminEmail = 'owner@example.test';
  const adminPassword = rand();
  let redirectUri = 'http://127.0.0.1:1/auth/callback';
  let mode: Misbehavior = 'none';
  let introspections = 0;
  let generation = 0; // the admin "session secret": bumping it ends every admin session
  const admins = new Map<string, { generation: number; expires: number }>(); // sha(token) → admin session
  const codes = new Map<string, Code>(); // sha(code)
  const grants = new Map<string, { session: string; expires: number }>(); // sha(grant)

  const cookie = (req: http.IncomingMessage, name: string) =>
    String(req.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim().split('='))
      .find(([k]) => k === name)?.[1];

  const adminAlive = (hash: string) => {
    const s = admins.get(hash);
    return Boolean(s && s.generation === generation && s.expires > Date.now());
  };
  function adminSession(req: http.IncomingMessage) {
    const token = cookie(req, ADMIN_COOKIE);
    return token && adminAlive(sha(token)) ? sha(token) : null;
  }
  function newAdminSession() {
    const token = rand();
    admins.set(sha(token), { generation, expires: Date.now() + 12 * 3600_000 });
    return token;
  }
  function grantActive(hash: string) {
    const g = grants.get(hash);
    return g && g.expires > Date.now() && adminAlive(g.session) ? g : null;
  }

  async function body(req: http.IncomingMessage): Promise<URLSearchParams> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 4096) throw new Error('size');
      chunks.push(chunk as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  function clientOk(req: http.IncomingMessage): boolean {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(String(req.headers.authorization ?? ''));
    if (!m) return false;
    const [id, secret] = Buffer.from(m[1]!, 'base64').toString('utf8').split(':').map(decodeURIComponent);
    return id === CLIENT_ID && timingSafeEqual(Buffer.from(sha(secret ?? '')), Buffer.from(sha(clientSecret)));
  }

  function json(res: http.ServerResponse, status: number, value: unknown) {
    if (mode === 'html') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<p>hi</p>');
    if (mode === 'oversize') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pad: 'x'.repeat(20_000) }));
    if (mode === 'redirect') return void res.writeHead(307, { location: 'http://127.0.0.1:9/elsewhere' }).end();
    if (mode === 'error500') return void res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"server_error"}');
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
  }
  const page = (res: http.ServerResponse, status: number, html: string, headers: Record<string, string> = {}) =>
    void res
      .writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers })
      .end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>parent site (fake)</title></head><body>${html}</body></html>`);

  function issueCode(session: string, challenge: string): string {
    const code = rand();
    codes.set(sha(code), { session, challenge, redirect: redirectUri, expires: Date.now() + 60_000, used: false });
    return code;
  }

  let origin = '';
  let adminOrigin = '';
  /** The site's admin CSRF rule: never cross-site; Origin must be the site or its admin host. */
  const trustedOrigin = (req: http.IncomingMessage) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const o = req.headers.origin;
    if (o) return o === origin || o === adminOrigin;
    return req.headers['sec-fetch-site'] === 'same-origin';
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://fake.invalid');
      const p = url.pathname;

      if (p === '/api/auth/login' && req.method === 'POST') {
        if (!trustedOrigin(req)) return json(res, 403, { error: 'origin' });
        const q = await body(req);
        if (q.get('email') !== adminEmail || q.get('password') !== adminPassword) return page(res, 401, '<p role="alert">로그인 실패</p>');
        const token = newAdminSession();
        res.writeHead(303, { 'set-cookie': `${ADMIN_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`, location: '/admin/' }).end();
        return;
      }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        if (!trustedOrigin(req)) return json(res, 403, { error: 'origin' });
        const s = adminSession(req);
        if (s) admins.delete(s);
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `${ADMIN_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` }).end('{"ok":true}');
        return;
      }
      if (p === '/__fixture/member-login') {
        // A Discord-authenticated, joined member: the cookie the member login sets. It must never open Ops.
        res.writeHead(303, { 'set-cookie': `${MEMBER_COOKIE}=${rand()}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`, location: '/' }).end();
        return;
      }

      if (p === PAGE) {
        const session = adminSession(req);
        if (!session) return void res.writeHead(302, { location: LOGIN, 'cache-control': 'no-store' }).end();
        // GET only: there is no confirm POST.
        if (req.method !== 'GET') return page(res, 405, '<h1>허용되지 않은 메서드</h1>');
        const host = String(req.headers.host ?? '').split(':')[0]!.toLowerCase();
        if (siteOf(new URL(redirectUri).hostname) !== siteOf(host)) return page(res, 503, '<h1>설정 오류</h1>');
        const q = url.searchParams;
        const one = (k: string) => (q.getAll(k).length === 1 ? q.get(k)! : null);
        const ok =
          one('client_id') === CLIENT_ID &&
          one('redirect_uri') === redirectUri &&
          one('code_challenge_method') === 'S256' &&
          /^[A-Za-z0-9_-]{43}$/.test(one('code_challenge') ?? '') &&
          /^[A-Za-z0-9_-]{43}$/.test(one('state') ?? '');
        // Never redirect an unverified request: error page, no code.
        if (!ok) return page(res, 400, '<h1>잘못된 요청</h1>');
        // No confirm step: a valid request from a live admin session gets the code at once.
        const code = issueCode(session, q.get('code_challenge')!);
        const target = new URL(redirectUri);
        target.search = new URLSearchParams({ code, state: q.get('state')! }).toString();
        return void res.writeHead(303, { location: target.toString(), 'referrer-policy': 'no-referrer' }).end();
      }

      if (p.startsWith('/api/ops-handoff/') && req.method === 'POST') {
        if (mode === 'slow') await new Promise((r) => setTimeout(r, 1500));
        if (req.headers.origin) return json(res, 405, { error: 'invalid_request' });
        if (!clientOk(req)) return json(res, 401, { error: 'invalid_client' });
        const q = await body(req);
        if (q.get('client_id') !== CLIENT_ID) return json(res, 401, { error: 'invalid_client' });
        if (p === '/api/ops-handoff/token') {
          const hash = sha(q.get('code') ?? '');
          const c = codes.get(hash);
          if (!c || c.expires <= Date.now() || c.redirect !== q.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
          if (c.used) {
            // RFC 9700 §4.2.4: a replayed code revokes what it produced.
            if (c.grant) grants.delete(c.grant);
            return json(res, 400, { error: 'invalid_grant' });
          }
          c.used = true;
          const challenge = createHash('sha256').update(q.get('code_verifier') ?? '').digest('base64url');
          if (challenge !== c.challenge || !adminAlive(c.session)) return json(res, 400, { error: 'invalid_grant' });
          const grant = rand();
          const expires = Math.min(Date.now() + 12 * 3600_000, admins.get(c.session)!.expires);
          grants.set(sha(grant), { session: c.session, expires });
          c.grant = sha(grant);
          return json(res, 200, { token_type: 'ops_grant', grant, subject: ADMIN_SUBJECT, identity: 'admin', expires_at: expires });
        }
        if (p === '/api/ops-handoff/introspect') {
          introspections++;
          const g = grantActive(sha(q.get('grant') ?? ''));
          return json(res, 200, g ? { active: true, subject: ADMIN_SUBJECT, identity: 'admin', expires_at: g.expires } : { active: false });
        }
        if (p === '/api/ops-handoff/revoke') {
          grants.delete(sha(q.get('grant') ?? ''));
          return json(res, 200, { ok: true });
        }
      }

      if (req.method !== 'GET') return void res.writeHead(405).end();
      if (p === LOGIN) {
        return page(
          res,
          200,
          '<h1>관리자 로그인</h1><form method="post" action="/api/auth/login"><label>이메일 <input name="email" type="email"></label><label>비밀번호 <input name="password" type="password"></label><button>로그인</button></form>',
        );
      }
      if (p === '/admin' || p.startsWith('/admin/')) {
        if (!adminSession(req)) return void res.writeHead(302, { location: LOGIN, 'cache-control': 'no-store' }).end();
        return page(res, 200, '<h1>관리자</h1>');
      }
      if (p === '/') return page(res, 200, '<h1>parent site</h1>');
      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
    }
  };

  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const scheme = tls ? 'https' : 'http';
  origin = `${scheme}://${hostname}:${port}`;
  adminOrigin = `${scheme}://admin.${hostname}:${port}`;

  return {
    kind: 'synthetic (tests/fixtures/fake-site.ts)',
    origin,
    memberLoginPath: '/__fixture/member-login',
    clientId: CLIENT_ID,
    clientSecret,
    adminEmail,
    adminPassword,
    setRedirectUri: (uri) => void (redirectUri = uri),
    misbehave: (m) => void (mode = m),
    changeAdminPassword: () => void generation++,
    async grantActive(grant) {
      return Boolean(grantActive(sha(grant)));
    },
    counts: () => ({ introspections }),
    issueCodeFor(challenge) {
      const adminToken = newAdminSession();
      return { adminToken, code: issueCode(sha(adminToken), challenge) };
    },
    adminLogout(adminToken) {
      if (adminToken) admins.delete(sha(adminToken));
      else admins.clear();
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Uniform entry point for the browser E2E (any other site implementation exports the same). */
export const startSiteFixture = (options: FakeSiteOptions): Promise<SiteFixture> => startFakeSite(options);
