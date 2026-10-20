import { NextResponse, type NextRequest } from 'next/server';
import { getAuthConfig, sessionCookieName } from './server/auth/config';
import { TOKEN_RE } from './server/auth/handoff';

const PUBLIC_PATHS = new Set(['/login', '/auth/start', '/auth/callback', '/api/health']);

/**
 * Optimistic pre-filter only: no well-formed session cookie → /login. The real check
 * (server-side session row + site grant) runs in every page, action and route via
 * requireSession(), so this never decides access on its own.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  let cookie: string | undefined;
  try {
    cookie = request.cookies.get(sessionCookieName(getAuthConfig()))?.value;
  } catch {
    cookie = undefined; // sign-in disabled or misconfigured: the login page explains
  }
  if (cookie && TOKEN_RE.test(cookie)) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)'],
};
