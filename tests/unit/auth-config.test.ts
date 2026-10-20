import { describe, expect, it } from 'vitest';
import { AuthConfigError, cookieOptions, loginCookieName, readAuthConfig, sessionCookieName } from '../../src/server/auth/config';

const SECRET = 's'.repeat(40);
const siteMode = {
  OPS_AUTH_MODE: 'site',
  OPS_PUBLIC_ORIGIN: 'https://ops.example.test',
  OPS_IDENTITY_KIND: 'admin',
  SITE_ORIGIN: 'https://site.example.test',
  SITE_CLIENT_ID: 'review-ops',
  SITE_CLIENT_SECRET: SECRET,
};
const noFile = () => {
  throw new Error('no file');
};

function message(env: Record<string, string | undefined>): string {
  try {
    readAuthConfig(env, noFile);
    return 'ok';
  } catch (error) {
    expect(error).toBeInstanceOf(AuthConfigError);
    return (error as Error).message;
  }
}

describe('auth config: fail closed', () => {
  it('is disabled unless OPS_AUTH_MODE is set explicitly', () => {
    expect(message({})).toMatch(/disabled/);
    expect(message({ ...siteMode, OPS_AUTH_MODE: 'yes' })).toMatch(/must be site or demo-password/);
  });

  it('accepts a complete site-mode config with secure host-only cookies', () => {
    const config = readAuthConfig(siteMode, noFile);
    expect(config.mode).toBe('site');
    expect(config.secureCookies).toBe(true);
    expect(sessionCookieName(config)).toBe('__Host-ops_session');
    expect(loginCookieName(config)).toBe('__Host-ops_login');
    expect(cookieOptions(config)).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    expect('domain' in cookieOptions(config)).toBe(false);
    if (config.mode === 'site') {
      expect(config.revalidateMs).toBe(30_000);
      expect(config.site.identity).toBe('admin');
    }
  });

  it('accepts only the admin identity; the member (Discord) identity is gone and fails closed', () => {
    expect(message({ ...siteMode, OPS_IDENTITY_KIND: 'member' })).toMatch(/must be admin/);
    expect(message({ ...siteMode, OPS_IDENTITY_KIND: undefined })).toMatch(/must be admin/);
    expect(message({ ...siteMode, OPS_IDENTITY_KIND: 'Admin' })).toMatch(/must be admin/);
  });

  it('a leftover member-era owner id is refused instead of ignored', () => {
    expect(message({ ...siteMode, OPS_OWNER_SUBJECT: 'member-subject-1' })).toMatch(/no longer used/);
    expect(message({ ...siteMode, OPS_OWNER_SUBJECT: '' })).toMatch(/no longer used/);
  });

  it('requires exact https origins (loopback http only outside production)', () => {
    expect(message({ ...siteMode, SITE_ORIGIN: 'http://site.example.test' })).toMatch(/https/);
    expect(message({ ...siteMode, SITE_ORIGIN: 'https://site.example.test/path' })).toMatch(/bare origin/);
    expect(message({ ...siteMode, OPS_PUBLIC_ORIGIN: 'https://user:pw@ops.example.test' })).toMatch(/bare origin/);
    expect(message({ ...siteMode, SITE_ORIGIN: 'http://127.0.0.1:8080', OPS_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' })).toBe('ok');
    expect(
      message({ ...siteMode, OPS_DEPLOYMENT: 'production', SITE_ORIGIN: 'http://127.0.0.1:8080' }),
    ).toMatch(/https/);
  });

  it('requires a strong client secret, preferring a mounted secret file', () => {
    expect(message({ ...siteMode, SITE_CLIENT_SECRET: 'short' })).toMatch(/32–512/);
    const fromFile = readAuthConfig({ ...siteMode, SITE_CLIENT_SECRET: undefined, SITE_CLIENT_SECRET_FILE: '/run/secrets/x' }, () => `${'f'.repeat(48)}\n`);
    expect(fromFile.mode === 'site' && fromFile.site.clientSecret).toBe('f'.repeat(48));
    expect(message({ ...siteMode, SITE_CLIENT_SECRET_FILE: '/missing' })).toMatch(/not readable/);
  });

  it('error messages never contain the secret value', () => {
    const msg = message({ ...siteMode, SITE_CLIENT_SECRET: `${SECRET} with space` });
    expect(msg.includes(SECRET)).toBe(false);
  });

  it('bounds the revalidation window', () => {
    expect(message({ ...siteMode, OPS_AUTH_REVALIDATE_SECONDS: '0' })).toBe('ok');
    expect(message({ ...siteMode, OPS_AUTH_REVALIDATE_SECONDS: '121' })).toMatch(/\[0, 120\]/);
    expect(message({ ...siteMode, OPS_AUTH_REVALIDATE_SECONDS: '-1' })).toMatch(/\[0, 120\]/);
  });

  it('demo-password mode is local only and refused in production', () => {
    const demo = { OPS_AUTH_MODE: 'demo-password', OPS_PUBLIC_ORIGIN: 'http://127.0.0.1:3000', OPS_PASSWORD_HASH: 'scrypt:1:1:1:a:b' };
    const config = readAuthConfig(demo, noFile);
    expect(config.mode).toBe('demo-password');
    expect(sessionCookieName(config)).toBe('ops_session');
    expect(message({ ...demo, OPS_DEPLOYMENT: 'production' })).toMatch(/refused/);
    expect(message({ ...demo, OPS_PASSWORD_HASH: '' })).toMatch(/OPS_PASSWORD_HASH/);
    expect(message({ ...demo, OPS_PUBLIC_ORIGIN: 'http://ops.example.test' })).toMatch(/https/);
  });
});
