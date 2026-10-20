import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SUBJECT, cookieOptions, loginCookieName, sessionCookieName } from '@/server/auth/config';
import { callbackUrl, HandoffError, randomToken, TOKEN_RE, tokenHash } from '@/server/auth/handoff';
import { authConfigOrNull, clientKey, handoffLimiter, siteClient } from '@/server/auth/session';
import { consumeLoginAttempt, createSession } from '@/server/auth/store';
import { getPool } from '@/server/db/pool';

export const dynamic = 'force-dynamic';

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

/**
 * Step 2: the site sent the browser back with a one-use code. Consume our state (atomically,
 * with the browser binding), redeem the code over the authenticated back channel with the
 * PKCE verifier, check it is the site admin, then start a fresh server-side session.
 * Failures say only which kind of failure it was — no codes, tokens or upstream details.
 */
export async function GET(request: NextRequest) {
  const config = authConfigOrNull();
  const origin = config?.publicOrigin ?? request.nextUrl.origin;
  const fail = (error: string) => {
    const response = NextResponse.redirect(new URL(`/login?error=${error}`, origin), 303);
    if (config) response.cookies.set(loginCookieName(config), '', { ...cookieOptions(config), maxAge: 0 });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
  if (!config || config.mode !== 'site') return fail('config');
  if (!handoffLimiter.take(`callback:${clientKey(request.headers)}`)) return fail('busy');

  const params = request.nextUrl.searchParams;
  const state = single(params, 'state');
  const binding = request.cookies.get(loginCookieName(config))?.value;
  if (!state || !TOKEN_RE.test(state) || !binding || !TOKEN_RE.test(binding)) return fail('state');

  const db = getPool();
  // Consume first, even on an error reply: a state is never usable twice.
  const attempt = await consumeLoginAttempt(db, tokenHash(state), tokenHash(binding));
  if (!attempt) return fail('state');
  if (params.has('error')) return fail('denied');
  const code = single(params, 'code');
  if (!code || !CODE_RE.test(code)) return fail('state');

  const site = siteClient(config)!;
  let grant;
  try {
    grant = await site.exchange({ code, verifier: attempt.verifier, redirectUri: callbackUrl(config) });
  } catch (error) {
    console.error(`auth: code exchange failed (${error instanceof HandoffError ? error.tag : 'error'})`);
    return fail('handoff');
  }
  if (grant.subject !== ADMIN_SUBJECT || grant.identity !== config.site.identity) {
    // Not the site admin: give the grant back right away. The site only ever issues admin grants.
    await site.revoke(grant.grant).catch(() => undefined);
    return fail('denied');
  }

  const now = new Date();
  const expiresAt = new Date(Math.min(now.getTime() + config.sessionTtlMs, grant.expiresAt));
  if (expiresAt.getTime() <= now.getTime()) return fail('handoff');
  const token = randomToken();
  await createSession(
    db,
    { tokenHash: tokenHash(token), mode: 'site', subject: grant.subject, siteGrant: grant.grant, expiresAt },
    now,
  );

  const response = NextResponse.redirect(new URL(attempt.returnTo, config.publicOrigin), 303);
  response.cookies.set(loginCookieName(config), '', { ...cookieOptions(config), maxAge: 0 });
  response.cookies.set(sessionCookieName(config), token, { ...cookieOptions(config), expires: expiresAt });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
