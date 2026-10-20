'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cookieOptions, sessionCookieName } from '../auth/config';
import { randomToken, safeReturnTo, tokenHash } from '../auth/handoff';
import { verifyPassword } from '../auth/password';
import { FailureLimiter } from '../auth/rate-limit';
import { authConfigOrNull, clientKey, getSession, isTrustedMutation, siteClient } from '../auth/session';
import { createSession, findSession, revokeSession } from '../auth/store';
import { getPool } from '../db/pool';

export interface LoginState {
  error: string | null;
}

const globalForLimiter = globalThis as unknown as { opsLoginLimiter?: FailureLimiter };
const limiter = (globalForLimiter.opsLoginLimiter ??= new FailureLimiter());

/** Password sign-in exists only in OPS_AUTH_MODE=demo-password (local demo / tests; refused in production). */
export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const config = authConfigOrNull();
  if (!config || config.mode !== 'demo-password') return { error: '비밀번호 로그인이 꺼져 있습니다.' };
  if (!(await isTrustedMutation(config))) return { error: '요청 출처를 확인할 수 없습니다.' };

  const key = clientKey(await headers());
  const wait = limiter.retryAfter(key);
  if (wait > 0) {
    return { error: `시도가 너무 많습니다. ${Math.ceil(wait / 60)}분 뒤에 다시 시도해 주세요.` };
  }

  const password = formData.get('password');
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
    return { error: '비밀번호를 입력해 주세요.' };
  }
  if (!(await verifyPassword(password, config.passwordHash))) {
    limiter.recordFailure(key);
    return { error: '비밀번호가 맞지 않습니다.' };
  }
  limiter.recordSuccess(key);

  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  await createSession(getPool(), { tokenHash: tokenHash(token), mode: 'demo-password', subject: 'demo-owner', siteGrant: null, expiresAt });
  (await cookies()).set(sessionCookieName(config), token, { ...cookieOptions(config), expires: expiresAt });
  redirect(safeReturnTo(formData.get('next')));
}

/**
 * Ends the session server-side (the row is revoked, so a copied cookie is dead at once), then
 * hands the site grant back upstream on a best-effort basis — the site would also drop it at
 * its own logout or expiry.
 */
export async function logout(): Promise<void> {
  const config = authConfigOrNull();
  if (config && (await isTrustedMutation(config))) {
    const jar = await cookies();
    const token = jar.get(sessionCookieName(config))?.value;
    const session = token ? await findSession(getPool(), tokenHash(token)) : null;
    if (session) {
      const grant = await revokeSession(getPool(), session.id);
      if (grant) await siteClient(config)?.revoke(grant).catch(() => console.error('auth: upstream grant revoke failed'));
    }
    jar.set(sessionCookieName(config), '', { ...cookieOptions(config), maxAge: 0 });
  } else if (await getSession()) {
    // Signed in but the request failed the origin check: refuse without side effects.
    redirect('/');
  }
  redirect('/login?reason=signed-out');
}
