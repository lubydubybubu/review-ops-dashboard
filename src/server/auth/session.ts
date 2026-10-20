import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { getPool } from '../db/pool';
import { AuthConfigError, getAuthConfig, sessionCookieName, type AuthConfig } from './config';
import { createSiteClient, isTrustedOrigin, type SiteClient } from './handoff';
import { RequestLimiter } from './rate-limit';
import { resolveSession, type ActiveSession, type Resolution } from './resolve';

const globals = globalThis as unknown as { opsSiteClient?: SiteClient; opsHandoffLimiter?: RequestLimiter };

export function siteClient(config: AuthConfig): SiteClient | undefined {
  if (config.mode !== 'site') return undefined;
  return (globals.opsSiteClient ??= createSiteClient(config.site));
}

/** Shared by /auth/start and /auth/callback. */
export const handoffLimiter = (globals.opsHandoffLimiter ??= new RequestLimiter());

/** The auth config, or null when sign-in is disabled / misconfigured (logged once per call, no values). */
export function authConfigOrNull(): AuthConfig | null {
  try {
    return getAuthConfig();
  } catch (error) {
    if (error instanceof AuthConfigError) console.error(`auth: ${error.message}`);
    else console.error('auth: configuration error');
    return null;
  }
}

/** Deduplicated per render; server actions and route handlers run it on every call. */
const currentResolution = cache(async (): Promise<Resolution> => {
  // Read the request first, even when sign-in is disabled: this keeps every protected page
  // dynamic, so nothing is ever prerendered at build time (with or without data).
  const jar = await cookies();
  const config = authConfigOrNull();
  if (!config) return { status: 'none' };
  const token = jar.get(sessionCookieName(config))?.value;
  const result = await resolveSession(getPool(), config, token, { site: siteClient(config) });
  if (result.status === 'unavailable') console.error(`auth: site check unavailable (${result.reason})`);
  return result;
});

export async function getSession(): Promise<ActiveSession | null> {
  const result = await currentResolution();
  return result.status === 'valid' ? result.session : null;
}

export async function hasSession(): Promise<boolean> {
  return (await getSession()) !== null;
}

/**
 * Every page, server action and route calls this (the proxy check is only a cookie-shape
 * pre-filter), so a matcher mistake can never expose data.
 */
export async function requireSession(): Promise<ActiveSession> {
  const result = await currentResolution();
  if (result.status === 'valid') return result.session;
  if (result.status === 'ended') redirect('/login?reason=ended');
  if (result.status === 'unavailable') redirect('/login?reason=unavailable');
  redirect('/login');
}

/**
 * CSRF defense for mutations, on top of SameSite=Lax cookies and Next.js' own Server Action
 * origin check: the browser's Origin must be exactly the configured Ops origin. Without an
 * Origin header only same-origin fetch metadata is accepted.
 */
export async function isTrustedMutation(config: AuthConfig | null = authConfigOrNull()): Promise<boolean> {
  return config !== null && isTrustedOrigin(await headers(), config.publicOrigin);
}

/** Rate-limit key. Forwarded headers are trusted only when explicitly configured for the proxy in front. */
export function clientKey(h: Headers): string {
  const header = process.env.OPS_TRUSTED_CLIENT_IP_HEADER?.toLowerCase();
  const value = header === 'cf-connecting-ip' || header === 'x-real-ip' ? h.get(header)?.trim() : undefined;
  return value && value.length <= 64 ? value : 'shared';
}
