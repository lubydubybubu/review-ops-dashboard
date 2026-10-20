/**
 * npm run test:e2e   (after `npm run build`)
 *
 * Self-contained browser test: fresh database (migrated from zero, DML-only app role,
 * demo seed) + a parent-site site fixture → `next start` on a private port behind a local TLS
 * proxy → system Chrome via playwright-core → admin sign-in handoff, revocation, SameSite /
 * CSRF and feature checks + screenshots → a short second phase in demo-password mode →
 * everything torn down. Exits non-zero if any check fails.
 *
 * Real cookie rules: everything the browser sees is https on RFC 6761 `.test` hostnames
 * (e2e/tls.ts) — the site at site.test, Ops at ops.site.test (same-site, like site.example /
 * ops.site.example), attacker pages at evil.site.test (same-site sibling) and other.test
 * (cross-site). The site sets its admin cookie as `__Host-…; Secure; HttpOnly; SameSite=Strict`
 * and the browser decides what to send; no cookie header is ever hand-set for those checks.
 *
 * Site fixture: the synthetic one in tests/fixtures/fake-site.ts, or any module exporting
 * the same `startSiteFixture` contract, named by `--site-fixture=<path>` or OPS_E2E_SITE_FIXTURE.
 *
 * Env: TEST_DATABASE_URL (superuser URL of a disposable server), CHROME_PATH,
 *      SCREENSHOT_DIR (default ../screenshots), E2E_PORT, OPS_E2E_SITE_FIXTURE.
 * Needs `openssl` on PATH (per-run throw-away CA).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { chromium, type BrowserContext, type Locator, type Page, type Request as PwRequest } from 'playwright-core';
import { addDays, todayInSeoul } from '../src/lib/domain/dates';
import { hashPassword } from '../src/server/auth/password';
import { createPool } from '../src/server/db/client';
import { grantAppRole, runMigrations } from '../src/server/db/migrate';
import { seedDemo } from '../src/server/db/seed';
import { assertDisposableServer, assertGeneratedDatabase } from '../tests/db-guard';
import { startSiteFixture, type FakeSiteOptions, type SiteFixture } from '../tests/fixtures/fake-site';
import { CHROME_HOST_RULES, createCertificates, CROSS_SITE_HOST, OPS_HOST, SIBLING_HOST, SITE_HOST, startTlsFront, type TestCertificates } from './tls';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:localtest@127.0.0.1:55433/ops_test';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const PORT = Number(process.env.E2E_PORT ?? 3217);
/** The runner's own requests go straight to `next start` (no TLS, no hostname). */
const DIRECT = `http://127.0.0.1:${PORT}`;
/** What the browser uses: https://ops.site.test:<proxy port>. Set once the proxy listens. */
let BASE = '';
const SCREENSHOT_DIR = path.resolve(process.env.SCREENSHOT_DIR ?? '../screenshots');
const ARTIFACT_DIR = path.resolve('e2e/.artifacts');
const APP_ROLE = 'ops_app_test';
const APP_ROLE_PASSWORD = 'ops_app_test_pw';
const PASSWORD = `e2e-${randomBytes(9).toString('base64url')}`;
/**
 * OPS_AUTH_REVALIDATE_SECONDS for the run (`--revalidate=N`, default 0 = every request). A site that
 * rate-limits its back channel (e.g. 120/min per client) needs N > 0 for the feature
 * tests; revocation checks then wait out the window first.
 */
const REVALIDATE_SECONDS = Number(process.argv.find((a) => a.startsWith('--revalidate='))?.slice('--revalidate='.length) ?? '0');
if (!Number.isInteger(REVALIDATE_SECONDS) || REVALIDATE_SECONDS < 0 || REVALIDATE_SECONDS > 10) throw new Error('--revalidate must be 0–10');
const afterWindow = () => new Promise((r) => setTimeout(r, REVALIDATE_SECONDS === 0 ? 0 : REVALIDATE_SECONDS * 1000 + 300));
const SESSION_COOKIE = '__Host-ops_session';
const ADMIN_COOKIE = '__Host-site_admin';

// ---------------------------------------------------------------- tiny harness

const results: { name: string; ok: boolean; error?: string }[] = [];

class AssertionError extends Error {}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}
function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AssertionError(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Label a step so a failure says which action broke, not just "fill timed out". */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(`[${label}] ${(error as Error).message}`, { cause: error });
  }
}

async function test(name: string, page: Page, fn: () => Promise<void>) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    const message = (error as Error).message.split('\n')[0] ?? String(error);
    results.push({ name, ok: false, error: message });
    console.log(`  ✗ ${name}\n      ${message}`);
    const file = path.join(ARTIFACT_DIR, `${name.replace(/[^\w가-힣]+/g, '-')}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- environment

function withDatabase(url: string, database: string, credentials?: { user: string; password: string }) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (credentials) {
    u.username = credentials.user;
    u.password = credentials.password;
  }
  return u.toString();
}

async function createDatabase(): Promise<{ name: string; adminUrl: string; appUrl: string }> {
  assertDisposableServer(ADMIN_URL);
  const name = `ops_e2e_${Date.now().toString(36)}_${process.pid}`;
  assertGeneratedDatabase(name);
  const maintenance = new pg.Client({ connectionString: withDatabase(ADMIN_URL, 'postgres') });
  await maintenance.connect();
  await maintenance.query(`create database ${maintenance.escapeIdentifier(name)}`);
  await maintenance.query(`
    do $$ begin
      if not exists (select from pg_roles where rolname = '${APP_ROLE}') then
        create role ${APP_ROLE} login password '${APP_ROLE_PASSWORD}' nosuperuser nocreatedb nocreaterole;
      end if;
    end $$`);
  await maintenance.end();

  const adminUrl = withDatabase(ADMIN_URL, name);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await runMigrations(admin);
  await grantAppRole(admin, APP_ROLE);
  await admin.end();

  const appUrl = withDatabase(ADMIN_URL, name, { user: APP_ROLE, password: APP_ROLE_PASSWORD });
  const seedPool = createPool(appUrl);
  await seedDemo(seedPool, todayInSeoul());
  await seedPool.end();
  return { name, adminUrl, appUrl };
}

async function dropDatabase(name: string) {
  assertDisposableServer(ADMIN_URL);
  assertGeneratedDatabase(name);
  const maintenance = new pg.Client({ connectionString: withDatabase(ADMIN_URL, 'postgres') });
  await maintenance.connect();
  await maintenance.query(`drop database if exists ${maintenance.escapeIdentifier(name)} with (force)`);
  await maintenance.end();
}

async function loadSiteFixture(options: FakeSiteOptions): Promise<SiteFixture> {
  const arg = process.argv.find((a) => a.startsWith('--site-fixture='))?.slice('--site-fixture='.length);
  const file = arg || process.env.OPS_E2E_SITE_FIXTURE;
  if (!file) return startSiteFixture(options);
  const mod = (await import(pathToFileURL(path.resolve(file)).href)) as {
    startSiteFixture?: typeof startSiteFixture;
    default?: { startSiteFixture?: typeof startSiteFixture };
  };
  const start = mod.startSiteFixture ?? mod.default?.startSiteFixture;
  if (!start) throw new Error('OPS_E2E_SITE_FIXTURE does not export startSiteFixture');
  return start(options);
}

type AuthEnv = { mode: 'site'; site: SiteFixture } | { mode: 'demo-password' };

async function startServer(appUrl: string, auth: AuthEnv, certs: TestCertificates): Promise<{ server: ChildProcess; logs: string[] }> {
  const logs: string[] = [];
  // Never inherit auth settings from the calling shell.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPS_|SITE_)/.test(k)));
  const authEnv =
    auth.mode === 'site'
      ? {
          OPS_AUTH_MODE: 'site',
          OPS_IDENTITY_KIND: 'admin',
          SITE_ORIGIN: auth.site.origin,
          SITE_CLIENT_ID: auth.site.clientId,
          SITE_CLIENT_SECRET: auth.site.clientSecret,
          SITE_TIMEOUT_MS: '1000',
          // default 0: every request re-checks the site grant, so revocation is observable at once
          OPS_AUTH_REVALIDATE_SECONDS: String(REVALIDATE_SECONDS),
        }
      : { OPS_AUTH_MODE: 'demo-password', OPS_PASSWORD_HASH: await hashPassword(PASSWORD) };
  const hook = pathToFileURL(path.resolve('e2e/dns-hook.mjs')).href;
  const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
    env: {
      ...inherited,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: appUrl,
      OPS_PUBLIC_ORIGIN: BASE,
      // back channel to https://site.test:<port>: test hostnames → loopback, trust the per-run CA
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${hook}`.trim(),
      NODE_EXTRA_CA_CERTS: certs.caFile,
      ...authEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => logs.push(String(d)));
  server.stderr?.on('data', (d) => logs.push(String(d)));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`next start exited early:\n${logs.join('')}`);
    try {
      const res = await fetch(`${DIRECT}/login`);
      if (res.ok) return { server, logs };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server did not become ready:\n${logs.join('')}`);
}

async function stopServer(server: ChildProcess | undefined) {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
  }
}

// ---------------------------------------------------------------- helpers

async function drag(page: Page, from: Locator, to: Locator) {
  await from.scrollIntoViewIfNeeded();
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  assert(a && b, 'drag source/target not visible');
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 48) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 10, start.y + 10, { steps: 5 });
  await page.mouse.move(end.x, end.y, { steps: 24 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

/**
 * Global shortcuts are attached by a React effect after hydration, which can land a few
 * ms after the `load` event. Retry the key until its target appears instead of racing.
 */
async function pressUntilVisible(page: Page, key: string, target: Locator, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    await page.keyboard.press(key);
    try {
      await target.waitFor({ timeout: 400 });
      return;
    } catch {
      // not hydrated yet — try again
    }
  }
  await target.waitFor({ timeout: 2000 });
}

const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text }).first();

async function reviewRow(db: pg.Pool, id: number) {
  const { rows } = await db.query(
    `select stage_id, received_on, shoot_on, shoot_starts_at, write_due_on, publish_planned_on, embargo_until
       from reviews where id = $1`,
    [id],
  );
  return rows[0] as Record<string, unknown>;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- the run

async function main() {
  if (!existsSync('.next/BUILD_ID')) {
    console.error('No production build found. Run `npm run build` first.');
    process.exit(1);
  }
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const today = todayInSeoul();
  console.log(`E2E · today (KST) ${today}`);
  const certs = await createCertificates();
  const front = await startTlsFront(certs, () => PORT);
  BASE = `https://${OPS_HOST}:${front.port}`;
  const database = await createDatabase();
  console.log(`  database ${database.name} migrated from zero + demo seed`);
  const db = createPool(database.adminUrl, 2);
  let server: ChildProcess | undefined;
  let logs: string[] = [];
  let context: BrowserContext | undefined;
  const userDataDir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ud-'));
  const site = await loadSiteFixture({ tls: { key: certs.key, cert: certs.cert }, hostname: SITE_HOST });
  site.setRedirectUri(`${BASE}/auth/callback`);
  const attacker = (host: string) => `https://${host}:${front.port}`;

  try {
    ({ server, logs } = await startServer(database.appUrl, { mode: 'site', site }, certs));
    console.log(`  next start on ${DIRECT}, browser origin ${BASE} (parent-site admin mode)`);
    console.log(`  site fixture: ${site.kind} at ${site.origin} · OPS_AUTH_REVALIDATE_SECONDS=${REVALIDATE_SECONDS}\n`);

    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: CHROME,
      headless: false, // we pass Chrome's own new headless mode explicitly
      args: ['--no-sandbox', '--headless=new', '--disable-gpu', '--hide-scrollbars', '--lang=ko-KR', CHROME_HOST_RULES],
      // per-run self-signed CA: certificate errors are ignored, but these are still https (secure) origins
      ignoreHTTPSErrors: true,
      // Chrome on Linux takes its UI locale (e.g. <input type=date> format) from LANGUAGE
      env: { ...process.env, LANGUAGE: 'ko' },
      viewport: { width: 1440, height: 900 },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      baseURL: BASE,
    });
    context.setDefaultTimeout(10_000);
    const page = context.pages()[0] ?? (await context.newPage());
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
    page.on('console', (msg) => {
      // Only Ops pages must be clean; the site fixture's deliberate 302/403/405 pages may log resource errors.
      const where = msg.location().url || page.url();
      if (msg.type() === 'error' && where.startsWith(BASE)) pageErrors.push(`console: ${msg.text()} @ ${where}`);
    });
    const callbackUrls: string[] = [];
    page.on('request', (req) => {
      if (req.url().startsWith(`${BASE}/auth/callback`)) callbackUrls.push(req.url());
    });
    const opsCookie = async () => (await context!.cookies(BASE)).find((c) => c.name === SESSION_COOKIE);
    const adminCookie = async () => (await context!.cookies(site.origin)).find((c) => c.name === ADMIN_COOKIE);
    const asCookie = (value: string) => ({ cookie: `${SESSION_COOKIE}=${value}` });
    const direct = (url: string) => url.replace(BASE, DIRECT);
    const liveSessions = async () =>
      Number((await db.query('select count(*)::int as n from auth_sessions where revoked_at is null and expires_at > now()')).rows[0].n);
    const adminCookieValues: string[] = [];

    /** Ops login page → "사이트 관리자 계정으로 로그인" → the site's /admin/ops-handoff/. */
    async function startHandoff() {
      if (!page.url().startsWith(`${BASE}/login`)) await page.goto('/login'); // keep an existing ?next=
      await page.getByRole('link', { name: '사이트 관리자 계정으로 로그인' }).click();
    }
    /** The admin signs in on the site itself (its own login page), like every /admin visit. */
    async function adminLoginOnSite() {
      await page.goto(`${site.origin}/admin/login.html`);
      await page.getByLabel('이메일').fill(site.adminEmail);
      await page.getByLabel('비밀번호').fill(site.adminPassword);
      await page.getByRole('button', { name: '로그인' }).click();
      await page.waitForURL(`${site.origin}/admin/`);
      const cookie = await adminCookie();
      assert(cookie, 'admin cookie not set');
      adminCookieValues.push(cookie.value);
    }
    /** With an admin session on the site: Ops → the site answers with the code at once (no confirm step) → back on Ops at `landing`. */
    async function signInViaAdmin(landing = '/') {
      await startHandoff();
      await page.waitForURL(`${BASE}${landing}`);
    }
    const handoffQuery = () =>
      new URLSearchParams({
        client_id: site.clientId,
        redirect_uri: `${BASE}/auth/callback`,
        state: randomBytes(32).toString('base64url'),
        code_challenge: randomBytes(32).toString('base64url'),
        code_challenge_method: 'S256',
      });

    await test('unauthenticated requests are redirected to the login page', page, async () => {
      const res = await fetch(`${DIRECT}/board`, { redirect: 'manual' });
      assertEqual(res.status, 307, 'status');
      assert(res.headers.get('location')?.startsWith('/login?next=%2Fboard'), `location ${res.headers.get('location')}`);
    });

    await test('build: no protected page was prerendered at build time', page, async () => {
      const manifest = JSON.parse(await readFile('.next/prerender-manifest.json', 'utf8')) as { routes: Record<string, unknown> };
      const prerendered = Object.keys(manifest.routes);
      for (const route of ['/', '/board', '/brands', '/reviews', '/settings', '/calendar', '/login']) {
        assert(!prerendered.includes(route), `${route} is static`);
      }
    });

    await test('health endpoint answers without auth and without details', page, async () => {
      const res = await fetch(`${DIRECT}/api/health`);
      assertEqual([res.status, await res.text(), res.headers.get('cache-control')], [200, '{"status":"ok"}', 'no-store'], 'health');
    });

    await test('site mode shows no password form and refuses a forged callback', page, async () => {
      await page.goto('/login');
      await page.getByRole('link', { name: '사이트 관리자 계정으로 로그인' }).waitFor();
      assertEqual(await page.getByLabel('비밀번호').count(), 0, 'password field');
      const forged = await fetch(`${DIRECT}/auth/callback?code=${'c'.repeat(43)}&state=${'s'.repeat(43)}`, { redirect: 'manual' });
      assertEqual([forged.status, forged.headers.get('location')], [303, `${BASE}/login?error=state`], 'forged callback');
      assertEqual(await liveSessions(), 0, 'sessions');
    });

    await test('no admin session: the handoff lands on the site ADMIN login page (never a member/Discord login)', page, async () => {
      await page.goto('/board');
      await page.waitForURL(/\/login\?next=%2Fboard/);
      await startHandoff();
      await page.waitForURL(`${site.origin}/admin/login.html`);
      await page.getByRole('heading', { name: '관리자 로그인' }).waitFor();
      assertEqual(await page.getByText(/discord/i).count(), 0, 'Discord mentioned');
      assertEqual([callbackUrls.length, await liveSessions()], [0, 0], 'callbacks / sessions');
    });

    await test('a logged-in Discord member without an admin session is refused', page, async () => {
      await page.goto(`${site.origin}${site.memberLoginPath}`);
      await page.waitForURL(`${site.origin}/`);
      const member = (await context!.cookies(site.origin)).find((c) => c.name === '__Host-site_member');
      assert(member, 'member cookie not set');
      await startHandoff();
      await page.waitForURL(`${site.origin}/admin/login.html`);
      assertEqual([callbackUrls.length, await liveSessions()], [0, 0], 'callbacks / sessions');
      assert(!(await adminCookie()), 'member login must not create an admin cookie');
    });

    await test('admin handoff: the SameSite=Strict admin cookie reaches the same-site handoff page; dashboard opens', page, async () => {
      await adminLoginOnSite();
      const admin = (await adminCookie())!;
      assertEqual([admin.sameSite, admin.secure, admin.httpOnly, admin.domain], ['Strict', true, true, SITE_HOST], 'admin cookie attributes (host-only)');
      await page.goto('/board');
      await page.waitForURL(/\/login\?next=%2Fboard/);
      // Ops (ops.site.test) → 303 → site.test/admin/ops-handoff/: a same-site top-level navigation,
      // so the browser itself attaches the Strict cookie and the site sends the code (not the login page).
      await signInViaAdmin('/board');
      await page.getByRole('heading', { name: '보드' }).waitFor();
      const cookie = await opsCookie();
      assert(cookie, 'session cookie missing');
      assertEqual([cookie.httpOnly, cookie.secure, cookie.sameSite, cookie.domain], [true, true, 'Lax', OPS_HOST], 'Ops cookie attributes (host-only)');
      assert(!(await context!.cookies(BASE)).some((c) => c.name === '__Host-ops_login'), 'login binding cookie not cleared');
      // What Chrome actually sent to the Ops host (Playwright's cookies(url) filter ignores host-only, so not that):
      assert(front.opsCookieNames.has(SESSION_COOKIE), 'proxy saw no Ops session cookie (check is blind)');
      for (const name of [ADMIN_COOKIE, '__Host-site_member']) assert(!front.opsCookieNames.has(name), `site cookie ${name} sent to the Ops host`);
      assertEqual(await liveSessions(), 1, 'live sessions');
      const { rows } = await db.query('select token_hash, subject from auth_sessions');
      assert(rows[0].token_hash !== cookie.value, 'raw token stored');
      assertEqual(rows[0].subject, 'site-admin', 'subject');
    });

    await test('replaying the callback URL (code + state) does nothing', page, async () => {
      assertEqual(callbackUrls.length, 1, 'callback requests');
      const replay = await fetch(direct(callbackUrls[0]!), { redirect: 'manual' });
      assertEqual([replay.status, replay.headers.get('location')], [303, `${BASE}/login?error=state`], 'replay');
      // even with the session cookie (as the same browser), the consumed state stays consumed
      const again = await fetch(direct(callbackUrls[0]!), { redirect: 'manual', headers: asCookie((await opsCookie())!.value) });
      assertEqual(again.headers.get('location'), `${BASE}/login?error=state`, 'replay with cookie');
      assertEqual(await liveSessions(), 1, 'live sessions');
    });

    await test('CSRF: a cross-origin server action POST is refused and logs nobody out', page, async () => {
      await page.goto('/');
      const actionField = await page.locator('input[name^="$ACTION_ID_"]').first().getAttribute('name');
      assert(actionField, 'logout action id not found');
      const form = new FormData();
      form.set(actionField, '');
      const res = await fetch(`${DIRECT}/`, {
        method: 'POST',
        redirect: 'manual',
        body: form,
        headers: { ...asCookie((await opsCookie())!.value), origin: 'http://evil.example' },
      });
      assert(res.status !== 303 || !res.headers.get('location')?.includes('signed-out'), 'cross-origin logout went through');
      assertEqual(await liveSessions(), 1, 'live sessions');
      const still = await fetch(`${DIRECT}/board`, { redirect: 'manual', headers: asCookie((await opsCookie())!.value) });
      assertEqual(still.status, 200, 'session still valid');
    });

    await test('SameSite=Strict in Chrome: cross-site navigation/POST never carry the admin session; a code from a planted same-site link is refused by the Ops callback', page, async () => {
      assert(await adminCookie(), 'precondition: admin is signed in on the site');
      const before = callbackUrls.length;
      const target = `${site.origin}/admin/ops-handoff/?${handoffQuery()}`;
      const link = `<a id="go" href="${escapeHtml(target)}">continue</a>`;
      front.setPage('/nav', link);
      // 1. cross-site top-level navigation (other.test → site.test): the Strict cookie is withheld → admin login
      await page.goto(`${attacker(CROSS_SITE_HOST)}/nav`);
      await page.locator('#go').click();
      await page.waitForURL(`${site.origin}/admin/login.html`);
      // the cookie still exists — it was only withheld: a direct visit is an admin again
      await page.goto(`${site.origin}/admin/`);
      await page.getByRole('heading', { name: '관리자', exact: true }).waitFor();
      // 2. the same link from a same-site sibling host carries it → the site issues a code and sends this browser
      //    to the one configured Ops callback; the browser holds no binding cookie for the planted state, so the
      //    callback refuses before any redemption and nobody is signed in by it
      await page.goto(`${attacker(SIBLING_HOST)}/nav`);
      const callback = page.waitForResponse((r) => r.url().startsWith(`${BASE}/auth/callback`));
      await page.locator('#go').click();
      const refused = await callback;
      assertEqual([refused.status(), refused.headers()['location']], [303, `${BASE}/login?error=state`], 'Ops callback on the planted code');
      assertEqual(callbackUrls.length, before + 1, 'the planted code went to the Ops callback only');
      assertEqual(new URL(callbackUrls.at(-1)!).searchParams.get('code')?.length, 43, 'a code was issued (no confirm step)');
      // the browser's own Ops session is untouched (/login bounces a signed-in browser to the dashboard)
      await page.waitForURL(`${BASE}/`);
      assertEqual(await liveSessions(), 1, 'no new session');
      // 3. POST is no entry any more: from another site → no cookie → admin login; from the sibling → 405, no code
      const fields = [...handoffQuery()].map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join('');
      front.setPage('/post', `<form method="post" action="${site.origin}/admin/ops-handoff/">${fields}<button id="send">send</button></form>`);
      await page.goto(`${attacker(CROSS_SITE_HOST)}/post`);
      await page.locator('#send').click();
      await page.waitForURL(`${site.origin}/admin/login.html`);
      await page.goto(`${attacker(SIBLING_HOST)}/post`);
      await page.locator('#send').click();
      await page.waitForURL(`${site.origin}/admin/ops-handoff/`);
      await page.getByRole('heading', { name: '허용되지 않은 메서드' }).waitFor();
      assertEqual([callbackUrls.length, await liveSessions()], [before + 1, 1], 'no further code reached Ops, no new session');
    });

    await test('site unreachable: Ops fails closed, then recovers without a new login', page, async () => {
      const cookie = (await opsCookie())!.value;
      site.misbehave('slow');
      await afterWindow();
      const down = await fetch(`${DIRECT}/board`, { redirect: 'manual', headers: asCookie(cookie) });
      site.misbehave('none');
      assertEqual([down.status, down.headers.get('location')], [307, '/login?reason=unavailable'], 'while down');
      const up = await fetch(`${DIRECT}/board`, { redirect: 'manual', headers: asCookie(cookie) });
      assertEqual(up.status, 200, 'after recovery');
    });

    // Taken first, so they show the pristine demo seed only.
    await test('screenshots: dashboard/board/calendar/detail × desktop/mobile × light/dark', page, async () => {
      const { rows } = await db.query(`select id from reviews where product_name = 'Northwind NX7 무선 헤드폰'`);
      const detailId = rows[0].id as number;
      const pages: [string, string][] = [
        ['dashboard', '/'],
        ['board', '/board'],
        ['calendar', '/calendar?view=month'],
        ['calendar-week', '/calendar?view=week'],
        ['detail', `/reviews/${detailId}`],
      ];
      const devices = [
        ['desktop', { width: 1440, height: 900 }],
        ['mobile', { width: 390, height: 844 }],
      ] as const;
      let count = 0;
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        for (const [device, viewport] of devices) {
          await page.setViewportSize(viewport);
          for (const [name, url] of pages) {
            await page.goto(url);
            if (name.startsWith('calendar')) await page.locator('.fc-event').first().waitFor();
            await page.evaluate(() => document.fonts.ready);
            await page.waitForTimeout(250);
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-${device}-${scheme}.png`) });
            count++;
          }
        }
      }
      await page.emulateMedia({ colorScheme: 'light' });
      await page.setViewportSize({ width: 1440, height: 900 });
      assertEqual(count, 20, 'screenshot count');
    });

    let createdId = 0;
    const productName = 'E2E 테스트 무선 마우스';
    const shootDate = addDays(today, 2);
    await test('quick create: C opens, Esc cancels, Enter saves; row appears without reload', page, async () => {
      await page.goto('/reviews');
      await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
      const dialog = page.getByRole('dialog', { name: '새 리뷰' });

      await step('C opens', () => pressUntilVisible(page, 'c', dialog));
      await step('Esc cancels', async () => {
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
      });
      await step('C reopens', () => pressUntilVisible(page, 'c', dialog));
      await step('fill form', async () => {
        await dialog.getByLabel('제품명').fill(productName);
        await dialog.getByLabel('템플릿').selectOption({ label: '대여 리뷰 (대여)' });
        await dialog.getByLabel('날짜', { exact: true }).fill(shootDate);
        await dialog.getByTestId('qc-preview').waitFor();
      });
      await step('Enter saves', async () => {
        await dialog.getByLabel('제품명').press('Enter');
        await toast(page, '리뷰를 만들었습니다').waitFor();
        await dialog.waitFor({ state: 'hidden' });
        await page.getByRole('link', { name: productName }).waitFor();
      });
      assert(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'page reloaded');

      const { rows } = await db.query(
        `select r.id, r.shoot_on, r.write_due_on, r.publish_planned_on, s.name as stage,
                (select count(*)::int from review_checklist_items c where c.review_id = r.id) as checklist
           from reviews r join workflow_stages s on s.id = r.stage_id where r.product_name = $1`,
        [productName],
      );
      assertEqual(rows.length, 1, 'created rows');
      createdId = rows[0].id;
      assertEqual(
        [rows[0].stage, rows[0].shoot_on, rows[0].write_due_on, rows[0].publish_planned_on, rows[0].checklist],
        ['입고', shootDate, addDays(shootDate, 4), addDays(shootDate, 6), 4],
        'template applied',
      );
    });

    await test('board: dragging a card to another column changes the stage and writes history', page, async () => {
      assert(createdId, 'needs the review from quick create');
      const { rows } = await db.query(`select id from workflow_stages where entity_type = 'review' and name = '촬영'`);
      const target = rows[0].id as number;
      await page.goto('/board');
      const card = page.locator(`article[data-review-id="${createdId}"]`);
      await drag(page, card, page.locator(`section[data-stage-id="${target}"]`));
      await toast(page, `‘${productName}’ → 촬영`).waitFor();
      await page.locator(`section[data-stage-id="${target}"] article[data-review-id="${createdId}"]`).waitFor();

      assertEqual((await reviewRow(db, createdId)).stage_id, target, 'stage in DB');
      const history = await db.query(
        `select f.name as "from", t.name as "to" from review_stage_history h
           left join workflow_stages f on f.id = h.from_stage_id join workflow_stages t on t.id = h.to_stage_id
          where h.review_id = $1 order by h.id`,
        [createdId],
      );
      assertEqual(history.rows, [{ from: null, to: '입고' }, { from: '입고', to: '촬영' }], 'history');

      await page.reload();
      await page.locator(`section[data-stage-id="${target}"] article[data-review-id="${createdId}"]`).waitFor();
    });

    await test('calendar: dragging a 발행 예정 chip moves that date only and never opens the peek', page, async () => {
      const { rows } = await db.query(
        `select id, publish_planned_on as date from reviews
          where archived_at is null and publish_planned_on is not null
            and extract(day from publish_planned_on + 1) > 1
          order by abs(publish_planned_on - $1::date), id limit 1`,
        [today],
      );
      const { id, date } = rows[0] as { id: number; date: string };
      const targetDate = addDays(date, 1);
      const before = await reviewRow(db, id);

      await page.goto(`/calendar?date=${date}&view=month`);
      const chip = page.locator(`.fc-event:has([data-review-id="${id}"][data-field="publish_planned"])`);
      await chip.waitFor();
      await drag(page, chip, page.locator(`td.fc-daygrid-day[data-date="${targetDate}"]`));
      await toast(page, '발행 예정 날짜를').waitFor();

      const after = await reviewRow(db, id);
      assertEqual(after.publish_planned_on, targetDate, 'publish_planned_on');
      assertEqual({ ...after, publish_planned_on: before.publish_planned_on }, before, 'other columns unchanged');
      await page.locator(`td[data-date="${targetDate}"] [data-review-id="${id}"][data-field="publish_planned"]`).waitFor();
      await page.waitForTimeout(300);
      assertEqual(await page.locator('dialog[data-peek][open]').count(), 0, 'a drag opened the peek');
      assertEqual(new URL(page.url()).searchParams.get('peek'), null, 'peek param after a drag');
    });

    // ------------------------------------------------ quick-edit peek
    const peek = page.getByRole('dialog', { name: '빠른 편집' });
    const { rows: peekRows } = await db.query(
      `select r.id, r.product_name as name, r.publish_planned_on as date, r.stage_id as stage
         from reviews r join workflow_stages s on s.id = r.stage_id
        where r.archived_at is null and r.publish_planned_on is not null and s.category_key <> 'done'
          and extract(day from r.publish_planned_on) between 2 and 25
        order by abs(r.publish_planned_on - $1::date), r.id limit 1`,
      [today],
    );
    const peekReview = peekRows[0] as { id: number; name: string; date: string; stage: number };
    const peekTarget = addDays(peekReview.date, 2);
    const peekChip = (date?: string) =>
      page.locator(`${date ? `td[data-date="${date}"] ` : ''}.fc-event:has([data-review-id="${peekReview.id}"][data-field="publish_planned"])`);
    const focusIsOnChip = () =>
      page.evaluate((id) => {
        const el = document.activeElement;
        return Boolean(el?.matches('.fc-event') && el.querySelector(`[data-review-id="${id}"][data-field="publish_planned"]`));
      }, peekReview.id);
    const peekInput = (selector: string) =>
      page.evaluate((s) => (document.querySelector(`dialog[data-peek] ${s}`) as HTMLInputElement | null)?.value, selector);
    async function openPeekFromChip(date: string) {
      await peekChip(date).click();
      await peek.waitFor();
      await step('peek loaded', async () => {
        const name = peek.getByLabel('제품명');
        await name.waitFor();
        assertEqual(await name.inputValue(), peekReview.name, 'peek product name');
      });
    }
    const closePeek = async () => {
      await page.keyboard.press('Escape');
      await peek.waitFor({ state: 'hidden' });
    };

    await test('peek: a calendar chip click opens a side panel; path unchanged; Tab stays inside; Esc closes, focus returns', page, async () => {
      await page.goto(`/calendar?date=${peekReview.date}&view=month`);
      await openPeekFromChip(peekReview.date);
      const url = new URL(page.url());
      assertEqual([url.pathname, url.searchParams.get('peek')], ['/calendar', String(peekReview.id)], 'URL (path unchanged, ?peek=id)');
      assertEqual(await page.locator('dialog[data-peek="panel"][open]').count(), 1, 'desktop shows the side panel');
      const box = (await peek.boundingBox())!;
      assert(Math.abs(box.width - 420) <= 2 && Math.abs(box.x + box.width - 1440) <= 2 && box.height >= 890, `panel box ${JSON.stringify(box)}`);
      // non-modal: the calendar stays visible and usable next to it
      assert(await page.locator('.fc-daygrid-body').isVisible(), 'calendar hidden');
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
        const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('dialog[data-peek]')));
        assert(inside, `focus left the panel after ${i + 1} Tab presses`);
      }
      await closePeek();
      await page.waitForTimeout(100);
      assert(await focusIsOnChip(), 'focus did not return to the clicked chip');
      assertEqual(new URL(page.url()).searchParams.get('peek'), null, 'peek param after close');

      // refresh with ?peek=<id> restores it
      await page.goto(`/calendar?date=${peekReview.date}&view=month&peek=${peekReview.id}`);
      await peek.getByLabel('제품명').waitFor();
      await closePeek();

      // week view chips open it too
      await page.goto(`/calendar?date=${peekReview.date}&view=week`);
      await openPeekFromChip(peekReview.date);
      assertEqual(new URL(page.url()).pathname, '/calendar', 'week view path');
      await closePeek();
    });

    await test('peek: edit 발행 예정 + stage, Ctrl+S saves → DB updated, chip moves without reload', page, async () => {
      const { rows } = await db.query(
        `select id from workflow_stages
          where entity_type = 'review' and archived_at is null and category_key = 'in_progress' and id <> $1
          order by sort limit 1`,
        [peekReview.stage],
      );
      const stageId = rows[0].id as number;
      await page.goto(`/calendar?date=${peekReview.date}&view=month`);
      await page.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
      const before = await reviewRow(db, peekReview.id);
      await openPeekFromChip(peekReview.date);
      await peek.getByLabel('발행 예정').fill(peekTarget);
      await peek.getByLabel('단계').selectOption(String(stageId));
      await peek.getByText('저장하지 않은 변경').waitFor();
      await page.keyboard.press('Control+s');
      await toast(page, '저장했습니다.').waitFor();
      await peekChip(peekTarget).waitFor();
      assertEqual(await peekChip(peekReview.date).count(), 0, 'chip still on the old day');
      const after = await reviewRow(db, peekReview.id);
      assertEqual([after.publish_planned_on, after.stage_id], [peekTarget, stageId], 'DB after peek save');
      assertEqual({ ...after, publish_planned_on: before.publish_planned_on, stage_id: before.stage_id }, before, 'other dates unchanged');
      const history = await db.query('select to_stage_id from review_stage_history where review_id = $1 order by id desc limit 1', [peekReview.id]);
      assertEqual(history.rows[0].to_stage_id, stageId, 'stage history written by the same rules');
      assert(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), 'page reloaded');
      // still open, showing what is stored, nothing unsaved
      assertEqual(await peek.getByLabel('발행 예정').inputValue(), peekTarget, 'panel shows the saved date');
      assertEqual(await peek.getByText('저장하지 않은 변경').count(), 0, 'still dirty after save');
      await closePeek();
    });

    await test('peek: unsaved-changes guard on Esc / ✕; 버리고 닫기 discards; DB untouched', page, async () => {
      const titleOf = async () => (await db.query('select title from reviews where id = $1', [peekReview.id])).rows[0].title as string | null;
      const before = await titleOf();
      await openPeekFromChip(peekTarget);
      await peek.getByLabel('작업 제목').fill('E2E 임시 제목');
      const guard = peek.getByRole('alertdialog');
      await page.keyboard.press('Escape');
      await guard.getByText('저장하지 않은 변경이 있습니다.').waitFor();
      assert(await peek.isVisible(), 'panel closed despite unsaved changes');
      await guard.getByRole('button', { name: '계속 편집' }).click();
      await guard.waitFor({ state: 'hidden' });
      assertEqual(await peek.getByLabel('작업 제목').inputValue(), 'E2E 임시 제목', 'edit kept');
      // Esc on the question means "keep editing"
      await page.keyboard.press('Escape');
      await guard.waitFor();
      await page.keyboard.press('Escape');
      await guard.waitFor({ state: 'hidden' });
      assert(await peek.isVisible(), 'Esc on the guard closed the panel');
      // the ✕ button asks too; discarding closes and writes nothing
      await peek.getByRole('button', { name: '닫기' }).first().click();
      await guard.getByRole('button', { name: '버리고 닫기' }).click();
      await peek.waitFor({ state: 'hidden' });
      assertEqual(await titleOf(), before, 'title in DB');
      await page.waitForTimeout(100);
      assert(await focusIsOnChip(), 'focus did not return to the (re-rendered) chip');
    });

    await test('peek: a save after the review changed elsewhere is refused with the Korean message', page, async () => {
      await openPeekFromChip(peekTarget);
      await db.query(`update reviews set title = '다른 탭에서 수정' where id = $1`, [peekReview.id]);
      await peek.getByLabel('우선순위').selectOption('low');
      await peek.getByRole('button', { name: '저장', exact: true }).click();
      await peek.getByRole('alert').filter({ hasText: '다른 곳에서 수정되었습니다. 새로고침 후 다시 시도하세요.' }).waitFor();
      const row = (await db.query('select title, priority from reviews where id = $1', [peekReview.id])).rows[0];
      assert(row.title === '다른 탭에서 수정' && row.priority !== 'low', `overwritten: ${JSON.stringify(row)}`);
      await peek.getByRole('button', { name: '새로고침' }).click();
      await page.waitForFunction(() => document.querySelector('dialog[data-peek]')?.textContent?.includes('불러오는 중') === false);
      await peek.getByLabel('작업 제목').waitFor();
      assertEqual(await peekInput('input[placeholder^="예: 한 달"]'), '다른 탭에서 수정', 'reloaded form');
      await closePeek();
    });

    await test('peek: 전체 페이지로 열기 and Ctrl+Enter open /reviews/[id]', page, async () => {
      await openPeekFromChip(peekTarget);
      await peek.getByRole('button', { name: '전체 페이지로 열기' }).click();
      await page.waitForURL(`${BASE}/reviews/${peekReview.id}`);
      assertEqual(await page.getByLabel('제품명').inputValue(), peekReview.name, 'full page review');
      assertEqual(await page.locator('dialog[data-peek][open]').count(), 0, 'peek left open');
      await page.goto(`/calendar?date=${peekReview.date}&view=month`);
      await openPeekFromChip(peekTarget);
      await page.keyboard.press('Control+Enter');
      await page.waitForURL(`${BASE}/reviews/${peekReview.id}`);
      await page.getByLabel('제품명').waitFor();
    });

    await test('peek: board card and dashboard list open the same peek in place', page, async () => {
      await page.goto('/board');
      await page.locator(`article[data-review-id="${peekReview.id}"] a`).click();
      await peek.getByLabel('제품명').waitFor();
      assertEqual(await peek.getByLabel('제품명').inputValue(), peekReview.name, 'board peek');
      assertEqual(new URL(page.url()).pathname, '/board', 'board path');
      await closePeek();
      await page.goto('/');
      const link = page.locator('main a[data-peek-link]').first();
      const id = Number(await link.getAttribute('data-peek-link'));
      const { rows } = await db.query('select product_name from reviews where id = $1', [id]);
      await link.click();
      await peek.getByLabel('제품명').waitFor();
      assertEqual(await peek.getByLabel('제품명').inputValue(), rows[0].product_name, 'dashboard peek');
      assertEqual(new URL(page.url()).pathname, '/', 'dashboard path');
      await closePeek();
    });

    await test('peek: screenshots desktop light/dark; mobile 390px is a bottom sheet (light/dark)', page, async () => {
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`/calendar?date=${peekReview.date}&view=month`);
        await openPeekFromChip(peekTarget);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `peek-desktop-${scheme}.png`) });
        await closePeek();

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`/calendar?date=${peekReview.date}&view=month`);
        await openPeekFromChip(peekTarget);
        assertEqual(await page.locator('dialog[data-peek="sheet"][open]').count(), 1, 'mobile shows the bottom sheet');
        const box = (await peek.boundingBox())!;
        assert(Math.abs(box.width - 390) <= 1 && Math.abs(box.y + box.height - 844) <= 1 && box.y > 60, `sheet box ${JSON.stringify(box)}`);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(250);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, `peek-mobile-${scheme}.png`) });
        await closePeek();
      }
      await page.emulateMedia({ colorScheme: 'light' });
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    // Regressions from the independent peek review: checklist changes must not touch the form or its version.
    async function createChecklistReview(name: string) {
      const { rows: todo } = await db.query(
        `select id from workflow_stages where entity_type = 'review' and archived_at is null and category_key = 'todo' order by sort limit 1`,
      );
      const { rows } = await db.query(
        `insert into reviews (product_name, title, stage_id, publish_planned_on, notes_md, channels)
         values ($1, 'Original title', $2, $3, 'Original hidden notes', array['blog']) returning id`,
        [name, todo[0].id, today],
      );
      const id = rows[0].id as number;
      await db.query(`insert into review_checklist_items (review_id, title, sort) values ($1, 'E2E 항목', 1)`, [id]);
      await page.goto(`/calendar?date=${today}&view=month&peek=${id}`);
      await peek.getByLabel('제품명', { exact: true }).waitFor();
      return id;
    }
    /** Run `act`, then wait until no server action has been in flight for a moment (its result is applied). */
    async function actionsSettled(act: () => Promise<unknown>, quietMs = 300) {
      let inflight = 0;
      let last = Date.now();
      const track = (delta: number) => (r: PwRequest) => {
        if (!r.headers()['next-action']) return;
        inflight += delta;
        last = Date.now();
      };
      const started = track(1);
      const ended = track(-1);
      page.on('request', started);
      page.on('requestfinished', ended);
      page.on('requestfailed', ended);
      try {
        await act();
        while (inflight > 0 || Date.now() - last < quietMs) await page.waitForTimeout(50);
      } finally {
        page.off('request', started);
        page.off('requestfinished', ended);
        page.off('requestfailed', ended);
      }
    }
    const reviewFields = async (id: number) =>
      (await db.query('select title, notes_md, channels, priority from reviews where id = $1', [id])).rows[0];
    const itemDone = async (id: number) =>
      (await db.query('select done_at is not null as done from review_checklist_items where review_id = $1', [id])).rows[0].done as boolean;

    await test('peek: after a checklist toggle an old form cannot overwrite another tab’s committed edit', page, async () => {
      const id = await createChecklistReview('E2E 체크리스트 버전');
      await peek.getByLabel('우선순위').selectOption('high');
      await db.query(
        `update reviews set title = 'New title in another tab', notes_md = 'New hidden notes in another tab', channels = array['youtube'] where id = $1`,
        [id],
      );
      await actionsSettled(() => peek.getByRole('checkbox').first().click());
      assertEqual(await itemDone(id), true, 'checklist toggle saved');
      await actionsSettled(() => peek.getByRole('button', { name: '저장', exact: true }).click());
      const row = await reviewFields(id);
      assertEqual(
        [row.title, row.notes_md, row.channels, row.priority],
        ['New title in another tab', 'New hidden notes in another tab', ['youtube'], 'normal'],
        'stored row after the old form was submitted',
      );
      await peek.getByRole('alert').filter({ hasText: '다른 곳에서 수정되었습니다. 새로고침 후 다시 시도하세요.' }).waitFor();
      await peek.getByRole('button', { name: '닫기' }).first().click();
      await peek.getByRole('alertdialog').getByRole('button', { name: '버리고 닫기' }).click();
      await peek.waitFor({ state: 'hidden' });
    });

    await test('peek: a checklist toggle keeps the add-item draft; main save and toggles keep each other', page, async () => {
      const id = await createChecklistReview('E2E 체크리스트 독립');
      await peek.getByLabel('작업 제목').fill('Panel title');
      await peek.getByLabel('체크리스트 항목 추가').fill('작성 중인 항목');
      await actionsSettled(() => peek.getByRole('checkbox').first().click());
      assertEqual(await peek.getByLabel('체크리스트 항목 추가').inputValue(), '작성 중인 항목', 'add-item draft after a toggle');
      assertEqual(await peek.getByLabel('작업 제목').inputValue(), 'Panel title', 'form edit after a toggle');
      await actionsSettled(() => peek.getByRole('button', { name: '저장', exact: true }).click());
      await toast(page, '저장했습니다.').waitFor();
      assertEqual([(await reviewFields(id)).title, await itemDone(id)], ['Panel title', true], 'after the main save');
      await actionsSettled(() => peek.getByRole('checkbox').first().click());
      assertEqual([(await reviewFields(id)).title, await itemDone(id)], ['Panel title', false], 'after a second toggle');
      assertEqual(await peek.getByText('저장하지 않은 변경').count(), 0, 'form dirty after save + toggle');
      await peek.getByLabel('체크리스트 항목 추가').fill('');
      await closePeek();
    });

    await test('calendar: week start setting re-renders without reload and persists', page, async () => {
      await page.goto('/calendar?view=month');
      const firstHeader = page.locator('.fc-col-header-cell').first();
      await firstHeader.filter({ hasText: '월' }).waitFor();
      await page.getByText('보기 설정').click();
      await page.getByRole('radio', { name: '일요일' }).check();
      await firstHeader.filter({ hasText: '일' }).waitFor();
      await page.waitForTimeout(300);
      await page.reload();
      await page.locator('.fc-col-header-cell').first().filter({ hasText: '일' }).waitFor();
      const { rows } = await db.query('select week_start from user_settings');
      assertEqual(rows[0].week_start, 0, 'persisted week_start');
      await page.getByText('보기 설정').click();
      await page.getByRole('radio', { name: '월요일' }).check();
      await page.locator('.fc-col-header-cell').first().filter({ hasText: '월' }).waitFor();
    });

    await test('command palette: Ctrl+K jumps to a review and to a date', page, async () => {
      await page.goto('/');
      const input = page.getByRole('combobox', { name: '리뷰 검색, 날짜 또는 명령' });
      await pressUntilVisible(page, 'Control+k', input);
      await input.fill('q1 usb');
      await page.getByRole('option', { name: /Kestrel Q1 USB 마이크/ }).waitFor();
      await input.press('Enter');
      await page.waitForURL(/\/reviews\/\d+$/);
      assertEqual(await page.getByLabel('제품명').inputValue(), 'Kestrel Q1 USB 마이크', 'opened review');

      const jump = addDays(today, 40);
      await page.keyboard.press('Control+k');
      await input.fill(jump);
      await page.getByRole('option', { name: /로 이동/ }).first().waitFor();
      await input.press('Enter');
      await page.waitForURL(`${BASE}/calendar?date=${jump}`);
      const [y, m] = jump.split('-').map(Number);
      await page.getByRole('heading', { name: `${y}년 ${m}월` }).waitFor();
    });

    await test('keyboard: ? opens the shortcut sheet, T jumps to today', page, async () => {
      await page.goto('/board');
      await pressUntilVisible(page, 'Shift+Slash', page.getByRole('dialog', { name: '단축키' }));
      await page.keyboard.press('Escape');
      await page.keyboard.press('t');
      await page.waitForURL(`${BASE}/calendar?date=${today}`);
    });


    await test('site admin logout ends the Ops session on the next check; a copied Ops cookie is dead too', page, async () => {
      const copied = (await opsCookie())!.value;
      // the admin logs out on the site: a real same-origin fetch from the admin page, like the admin UI does
      await page.goto(`${site.origin}/admin/`);
      const status = await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status);
      assertEqual(status, 200, 'site admin logout');
      assert(!(await adminCookie()), 'admin cookie still set');
      // the browser's very next Ops request (after the revalidation window, if any) learns the session ended…
      await afterWindow();
      await page.goto('/board');
      await page.waitForURL(`${BASE}/login?reason=ended`);
      await page.getByText('사이트 관리자 세션이 끝나').waitFor();
      assertEqual(await liveSessions(), 0, 'live sessions');
      // …and the same cookie value replayed from elsewhere is just dead
      const dead = await fetch(`${DIRECT}/board`, { redirect: 'manual', headers: asCookie(copied) });
      assertEqual([dead.status, dead.headers.get('location')], [307, '/login'], 'copied cookie');
    });

    await test('site admin password change (session secret rotation) ends the Ops session', page, async () => {
      await adminLoginOnSite();
      await signInViaAdmin('/');
      const copied = (await opsCookie())!.value;
      site.changeAdminPassword();
      await afterWindow();
      await page.goto('/board');
      await page.waitForURL(`${BASE}/login?reason=ended`);
      const dead = await fetch(`${DIRECT}/board`, { redirect: 'manual', headers: asCookie(copied) });
      assertEqual([dead.status, dead.headers.get('location')], [307, '/login'], 'copied cookie');
      // the old admin cookie is dead on the site too
      await page.goto(`${site.origin}/admin/`);
      await page.waitForURL(`${site.origin}/admin/login.html`);
      assertEqual(await liveSessions(), 0, 'live sessions');
    });

    await test('Ops logout ends the session server-side and hands the grant back', page, async () => {
      await adminLoginOnSite();
      await signInViaAdmin('/');
      const copied = (await opsCookie())!.value;
      const { rows } = await db.query('select site_grant from auth_sessions where revoked_at is null');
      assertEqual(rows.length, 1, 'live session rows');
      const grant = rows[0].site_grant as string;
      assertEqual(await site.grantActive(grant), true, 'grant before logout');
      await page.getByRole('button', { name: '로그아웃' }).click();
      await page.waitForURL(/\/login\?reason=signed-out/);
      assert(!(await opsCookie()), 'cookie still set');
      const dead = await fetch(`${DIRECT}/board`, { redirect: 'manual', headers: asCookie(copied) });
      assertEqual([dead.status, dead.headers.get('location')], [307, '/login'], 'copied cookie after Ops logout');
      assertEqual(await site.grantActive(grant), false, 'grant after logout');
      assert(await adminCookie(), 'Ops logout does not touch the site admin session');
      await page.goto('/board');
      await page.waitForURL(/\/login\?next=%2Fboard/);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'login-desktop-light.png') });
    });

    await test('server logs hold no client secret, admin cookie, codes, states or session tokens', page, async () => {
      const text = logs.join('');
      const secrets = [site.clientSecret, ...adminCookieValues, ...callbackUrls.flatMap((u) => [...new URL(u).searchParams.values()])];
      const { rows } = await db.query('select site_grant from auth_sessions');
      for (const value of [...secrets, ...rows.map((r) => r.site_grant as string)]) {
        assert(!text.includes(value), 'a secret value appears in the server log');
      }
      assert(adminCookieValues.length === 3, `expected 3 admin logins, got ${adminCookieValues.length}`);
      assert(text.includes('auth: site check unavailable (timeout)'), 'expected the fixed-tag outage log line');
    });

    // ------------------------------------------------ phase 2: explicit demo-password mode
    await stopServer(server);
    ({ server, logs } = await startServer(database.appUrl, { mode: 'demo-password' }, certs));
    console.log(`  next start on ${DIRECT} (demo-password mode)`);

    await test('demo-password mode: wrong password refused, right one opens the dashboard, logout ends it', page, async () => {
      await context!.clearCookies();
      await page.goto('/');
      await page.waitForURL(/\/login/);
      await page.getByText('데모 모드').waitFor();
      await page.getByLabel('비밀번호').fill('not-the-password');
      await page.getByRole('button', { name: '로그인' }).click();
      await page.getByRole('alert').filter({ hasText: '비밀번호가 맞지 않습니다' }).waitFor();
      await page.getByLabel('비밀번호').fill(PASSWORD);
      await page.getByRole('button', { name: '로그인' }).click();
      await page.waitForURL(`${BASE}/`);
      await page.getByRole('heading', { name: '대시보드' }).waitFor();
      const cookie = await opsCookie();
      assert(cookie?.httpOnly, 'session cookie must be httpOnly');
      const copied = cookie.value;
      await page.getByRole('button', { name: '로그아웃' }).click();
      await page.waitForURL(/\/login\?reason=signed-out/);
      const dead = await fetch(`${DIRECT}/board`, { redirect: 'manual', headers: asCookie(copied) });
      assertEqual(dead.status, 307, 'copied demo cookie after logout');
      assertEqual(await page.getByRole('link', { name: '사이트 관리자 계정으로 로그인' }).count(), 0, 'site link in demo mode');
    });

    await test('no uncaught errors in the browser console', page, async () => {
      // the deliberate wrong-password POST is not an error; anything else on an Ops page is
      assertEqual(pageErrors, [], 'browser errors');
    });
  } finally {
    await context?.close().catch(() => undefined);
    await stopServer(server);
    await site.close();
    await front.close();
    await db.end();
    await dropDatabase(database.name);
    await rm(userDataDir, { recursive: true, force: true });
    await certs.cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0 && logs.length > 0) {
    console.log('\n--- server log (tail) ---');
    console.log(logs.join('').split('\n').slice(-40).join('\n'));
  }
  console.log(`\nE2E: ${results.length - failed.length} passed, ${failed.length} failed (${results.length} total)`);
  console.log(`site fixture: ${site.kind} · back-channel introspections: ${site.counts().introspections} · revalidate ${REVALIDATE_SECONDS}s`);
  console.log(`screenshots: ${SCREENSHOT_DIR}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  console.log('\nE2E: run aborted before completion');
  process.exit(1);
});
