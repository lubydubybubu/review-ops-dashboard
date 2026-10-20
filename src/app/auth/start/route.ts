import { NextResponse, type NextRequest } from 'next/server';
import { cookieOptions, loginCookieName } from '@/server/auth/config';
import { authorizeUrl, pkceChallenge, randomToken, safeReturnTo, tokenHash } from '@/server/auth/handoff';
import { authConfigOrNull, clientKey, handoffLimiter } from '@/server/auth/session';
import { createLoginAttempt, LOGIN_ATTEMPT_TTL_MS } from '@/server/auth/store';
import { getPool } from '@/server/db/pool';

export const dynamic = 'force-dynamic';

/**
 * Step 1 of the parent-site handoff: remember (state → PKCE verifier, browser binding, return path)
 * server-side and send the browser to the site's handoff page (which answers an admin session with a code at once). Only the state and the
 * S256 challenge leave Ops; the verifier never does.
 */
export async function GET(request: NextRequest) {
  const config = authConfigOrNull();
  const back = (query: string) => NextResponse.redirect(new URL(`/login${query}`, config?.publicOrigin ?? request.nextUrl.origin), 303);
  if (!config || config.mode !== 'site') return back('');
  if (!handoffLimiter.take(`start:${clientKey(request.headers)}`)) return back('?error=busy');

  const state = randomToken();
  const binding = randomToken();
  const verifier = randomToken();
  const stored = await createLoginAttempt(getPool(), {
    stateHash: tokenHash(state),
    bindingHash: tokenHash(binding),
    verifier,
    returnTo: safeReturnTo(request.nextUrl.searchParams.get('next')),
  });
  if (!stored) return back('?error=busy');

  const response = NextResponse.redirect(authorizeUrl(config, { state, challenge: pkceChallenge(verifier) }), 303);
  response.cookies.set(loginCookieName(config), binding, { ...cookieOptions(config), maxAge: LOGIN_ATTEMPT_TTL_MS / 1000 });
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
