import { readFileSync } from 'node:fs';

/**
 * Auth configuration from the environment. Read lazily (not at import time) so `next build`
 * works without secrets. Anything missing or malformed throws AuthConfigError, whose message
 * is fixed text (never a secret value) — callers fail closed.
 *
 * OPS_AUTH_MODE
 *   (unset)        sign-in disabled: every protected page stays behind /login
 *   site           one-time handoff from the existing parent-site ADMIN login (production mode)
 *   demo-password  local demo / tests only; refused when OPS_DEPLOYMENT=production
 */

export type AuthMode = 'site' | 'demo-password';

interface BaseConfig {
  /** Exact origin the browser uses for Ops, e.g. https://ops.example.com */
  publicOrigin: string;
  /** Secure + __Host- cookies; true whenever publicOrigin is https. */
  secureCookies: boolean;
  sessionTtlMs: number;
}

export interface SiteConfig {
  /** Exact origin of the existing site (authorization + back-channel). */
  origin: string;
  clientId: string;
  clientSecret: string;
  /** The only site identity Ops accepts: the parent-site admin session (docs/AUTH.md). */
  identity: 'admin';
  timeoutMs: number;
}

/** Subject the site reports for its single admin; the only one Ops lets in. */
export const ADMIN_SUBJECT = 'site-admin';

export interface SiteAuthConfig extends BaseConfig {
  mode: 'site';
  site: SiteConfig;
  /** Max age of the last back-channel check before a request re-checks the site grant. */
  revalidateMs: number;
}

export interface DemoAuthConfig extends BaseConfig {
  mode: 'demo-password';
  passwordHash: string;
}

export type AuthConfig = SiteAuthConfig | DemoAuthConfig;

export class AuthConfigError extends Error {
  override name = 'AuthConfigError';
}

const CLIENT_ID_RE = /^[a-z0-9-]{3,64}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60_000;

type Env = Record<string, string | undefined>;

function exactOrigin(value: string | undefined, name: string, { allowLoopbackHttp }: { allowLoopbackHttp: boolean }): string {
  if (!value) throw new AuthConfigError(`${name} is not set`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthConfigError(`${name} is not a URL`);
  }
  if (url.origin !== value.replace(/\/$/, '') || url.username || url.password) {
    throw new AuthConfigError(`${name} must be a bare origin (scheme://host[:port])`);
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopbackHttp)) {
    throw new AuthConfigError(`${name} must use https`);
  }
  return url.origin;
}

function boundedInt(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new AuthConfigError(`${name} must be an integer in [${min}, ${max}]`);
  return n;
}

function readSecret(env: Env, readFile: (path: string) => string): string {
  const file = env.SITE_CLIENT_SECRET_FILE;
  let secret: string | undefined;
  if (file) {
    try {
      secret = readFile(file).trim();
    } catch {
      throw new AuthConfigError('SITE_CLIENT_SECRET_FILE is not readable');
    }
  } else {
    secret = env.SITE_CLIENT_SECRET?.trim();
  }
  if (!secret || secret.length < 32 || secret.length > 512 || !/^[\x21-\x7e]+$/.test(secret)) {
    throw new AuthConfigError('SITE client secret must be 32–512 printable characters');
  }
  return secret;
}

export function readAuthConfig(env: Env = process.env, readFile = (p: string) => readFileSync(p, 'utf8')): AuthConfig {
  const production = env.OPS_DEPLOYMENT === 'production';
  const mode = env.OPS_AUTH_MODE?.trim();
  if (!mode) throw new AuthConfigError('sign-in is disabled (OPS_AUTH_MODE is not set)');
  if (mode === 'demo-password' && production) {
    throw new AuthConfigError('demo-password mode is refused when OPS_DEPLOYMENT=production');
  }

  const publicOrigin = exactOrigin(env.OPS_PUBLIC_ORIGIN, 'OPS_PUBLIC_ORIGIN', { allowLoopbackHttp: !production });
  const base: BaseConfig = {
    publicOrigin,
    secureCookies: publicOrigin.startsWith('https:'),
    sessionTtlMs: boundedInt(env.OPS_SESSION_TTL_SECONDS, 'OPS_SESSION_TTL_SECONDS', DEFAULT_SESSION_TTL_MS / 1000, 300, 86_400) * 1000,
  };

  if (mode === 'demo-password') {
    const passwordHash = env.OPS_PASSWORD_HASH?.trim();
    if (!passwordHash || !passwordHash.startsWith('scrypt:')) {
      throw new AuthConfigError('OPS_PASSWORD_HASH is missing or malformed — run `npm run hash-password`');
    }
    return { ...base, mode, passwordHash };
  }

  if (mode !== 'site') throw new AuthConfigError('OPS_AUTH_MODE must be site or demo-password');

  // Member (Discord) login never grants Ops access. A leftover member-era setting fails closed instead of
  // being ignored, so a half-migrated config cannot look enabled.
  const identity = env.OPS_IDENTITY_KIND?.trim();
  if (identity !== 'admin') throw new AuthConfigError('OPS_IDENTITY_KIND must be admin (member sign-in was removed)');
  if (env.OPS_OWNER_SUBJECT !== undefined) {
    throw new AuthConfigError('OPS_OWNER_SUBJECT is no longer used (admin identity) — remove it');
  }

  const clientId = env.SITE_CLIENT_ID?.trim() ?? '';
  if (!CLIENT_ID_RE.test(clientId)) throw new AuthConfigError('SITE_CLIENT_ID is missing or malformed');

  return {
    ...base,
    mode,
    revalidateMs: boundedInt(env.OPS_AUTH_REVALIDATE_SECONDS, 'OPS_AUTH_REVALIDATE_SECONDS', 30, 0, 120) * 1000,
    site: {
      origin: exactOrigin(env.SITE_ORIGIN, 'SITE_ORIGIN', { allowLoopbackHttp: !production }),
      clientId,
      clientSecret: readSecret(env, readFile),
      identity,
      timeoutMs: boundedInt(env.SITE_TIMEOUT_MS, 'SITE_TIMEOUT_MS', 5000, 500, 10_000),
    },
  };
}

const globalForConfig = globalThis as unknown as { opsAuthConfig?: AuthConfig };

/** Process-wide config; only a successful read is cached, so a fixed env starts working without a stale error. */
export function getAuthConfig(): AuthConfig {
  return (globalForConfig.opsAuthConfig ??= readAuthConfig());
}

export function sessionCookieName(config: Pick<BaseConfig, 'secureCookies'>): string {
  return config.secureCookies ? '__Host-ops_session' : 'ops_session';
}

export function loginCookieName(config: Pick<BaseConfig, 'secureCookies'>): string {
  return config.secureCookies ? '__Host-ops_login' : 'ops_login';
}

/**
 * Host-only cookie attributes (no Domain, ever). Also used to clear a cookie: browsers drop a
 * `__Host-` deletion that does not repeat Secure and Path=/.
 */
export function cookieOptions(config: Pick<BaseConfig, 'secureCookies'>) {
  return { httpOnly: true, secure: config.secureCookies, sameSite: 'lax' as const, path: '/' };
}
