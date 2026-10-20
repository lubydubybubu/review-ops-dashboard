import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ADMIN_SUBJECT, type SiteAuthConfig, type SiteConfig } from './config';

/**
 * Ops side of the parent-site one-time login handoff (protocol: docs/AUTH.md).
 *
 * Shape follows the OAuth 2.0 authorization-code grant with PKCE S256 (RFC 6749 / 7636) and
 * the RFC 9700 rules — exact redirect URI, one-use short-lived code, state bound to this
 * browser — but the site is not an OAuth/OIDC server, so this is a small purpose-built
 * client rather than a generic library. No JWTs: every credential is an opaque random value
 * that the issuer stores hashed and checks server-side.
 */

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const GRANT_RE = /^[A-Za-z0-9_-]{43,128}$/;
const MAX_RESPONSE_BYTES = 8 * 1024;

/** Under /admin/ on the site: guarded by the edge (Access) and the admin login like every admin page. */
export const AUTHORIZE_PATH = '/admin/ops-handoff/';
export const TOKEN_PATH = '/api/ops-handoff/token';
export const INTROSPECT_PATH = '/api/ops-handoff/introspect';
export const REVOKE_PATH = '/api/ops-handoff/revoke';
export const CALLBACK_PATH = '/auth/callback';

/** 256-bit random value, base64url (43 chars). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Storage key for a bearer value: we keep only the hash, never the value itself. */
export function tokenHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function callbackUrl(config: Pick<SiteAuthConfig, 'publicOrigin'>): string {
  return `${config.publicOrigin}${CALLBACK_PATH}`;
}

export function authorizeUrl(config: SiteAuthConfig, { state, challenge }: { state: string; challenge: string }): string {
  const url = new URL(AUTHORIZE_PATH, config.site.origin);
  url.search = new URLSearchParams({
    client_id: config.site.clientId,
    redirect_uri: callbackUrl(config),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

/**
 * Where to land after sign-in: an in-app absolute path only. Anything else (other origins,
 * protocol-relative `//x`, backslash tricks, control characters, auth endpoints) becomes `/`.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  const base = 'http://ops.invalid';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return '/';
  }
  if (url.origin !== base || url.pathname.startsWith('/auth/') || url.pathname === '/login') return '/';
  return `${url.pathname}${url.search}`;
}

/**
 * CSRF check for mutations: Origin must be exactly the Ops origin. Without an Origin header
 * only same-origin fetch metadata passes; any cross-site metadata fails.
 */
export function isTrustedOrigin(headers: Pick<Headers, 'get'>, publicOrigin: string): boolean {
  if (headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = headers.get('origin');
  if (origin) return origin === publicOrigin;
  return headers.get('sec-fetch-site') === 'same-origin';
}

// ---------------------------------------------------------------- back-channel client

/** Fixed, secret-free failure tags; safe to log. */
export type HandoffFailure =
  | 'timeout'
  | 'transport'
  | 'redirect'
  | 'origin'
  | 'content-type'
  | 'size'
  | 'json'
  | 'schema'
  | 'invalid_grant'
  | 'invalid_client'
  | 'rate_limited'
  | `status_${number}`;

export class HandoffError extends Error {
  override name = 'HandoffError';
  constructor(readonly tag: HandoffFailure) {
    super(`parent-site handoff failed: ${tag}`);
  }
}

const tokenResponse = z.object({
  token_type: z.literal('ops_grant'),
  grant: z.string().regex(GRANT_RE),
  subject: z.literal(ADMIN_SUBJECT),
  identity: z.literal('admin'),
  expires_at: z.number().int().positive(),
});

const introspectResponse = z.discriminatedUnion('active', [
  z.object({ active: z.literal(false) }),
  z.object({
    active: z.literal(true),
    subject: z.literal(ADMIN_SUBJECT),
    identity: z.literal('admin'),
    expires_at: z.number().int().positive(),
  }),
]);

export interface Grant {
  grant: string;
  subject: string;
  identity: 'admin';
  expiresAt: number;
}

export type Introspection = { active: false } | { active: true; subject: string; identity: 'admin'; expiresAt: number };

export interface SiteClient {
  exchange(input: { code: string; verifier: string; redirectUri: string }): Promise<Grant>;
  introspect(grant: string): Promise<Introspection>;
  revoke(grant: string): Promise<void>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

async function readBounded(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) throw new HandoffError('size');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new HandoffError('size');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createSiteClient(site: SiteConfig, { fetch: fetcher = globalThis.fetch as Fetch }: { fetch?: Fetch } = {}): SiteClient {
  // RFC 6749 §2.3.1 client_secret_basic: form-urlencode each part, then base64.
  const basic = Buffer.from(`${encodeURIComponent(site.clientId)}:${encodeURIComponent(site.clientSecret)}`).toString('base64');

  async function post(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, site.origin);
    if (url.origin !== site.origin) throw new HandoffError('origin');
    let res: Response;
    try {
      res = await fetcher(url.toString(), {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(site.timeoutMs),
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({ client_id: site.clientId, ...params }).toString(),
      });
    } catch (error) {
      const name = (error as Error | undefined)?.name;
      throw new HandoffError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport');
    }
    // `redirect: 'error'` already rejects; this also covers fetch implementations that ignore it.
    if (res.redirected || (res.status >= 300 && res.status < 400)) throw new HandoffError('redirect');
    if (res.url && new URL(res.url).origin !== site.origin) throw new HandoffError('origin');
    let text: string;
    try {
      text = await readBounded(res);
    } catch (error) {
      if (error instanceof HandoffError) throw error;
      const name = (error as Error | undefined)?.name;
      throw new HandoffError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport');
    }
    if (!/^application\/json(?:;|$)/i.test(res.headers.get('content-type') ?? '')) throw new HandoffError('content-type');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HandoffError('json');
    }
    if (res.status === 200) return body;
    const code = (body as { error?: unknown } | null)?.error;
    if (res.status === 400 && code === 'invalid_grant') throw new HandoffError('invalid_grant');
    if (res.status === 401 && code === 'invalid_client') throw new HandoffError('invalid_client');
    if (res.status === 429) throw new HandoffError('rate_limited');
    throw new HandoffError(`status_${res.status}`);
  }

  return {
    async exchange({ code, verifier, redirectUri }) {
      const parsed = tokenResponse.safeParse(
        await post(TOKEN_PATH, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }),
      );
      if (!parsed.success) throw new HandoffError('schema');
      const { grant, subject, identity, expires_at } = parsed.data;
      return { grant, subject, identity, expiresAt: expires_at };
    },
    async introspect(grant) {
      const parsed = introspectResponse.safeParse(await post(INTROSPECT_PATH, { grant }));
      if (!parsed.success) throw new HandoffError('schema');
      if (!parsed.data.active) return { active: false };
      const { subject, identity, expires_at } = parsed.data;
      return { active: true, subject, identity, expiresAt: expires_at };
    },
    async revoke(grant) {
      const body = await post(REVOKE_PATH, { grant });
      if ((body as { ok?: unknown } | null)?.ok !== true) throw new HandoffError('schema');
    },
  };
}
