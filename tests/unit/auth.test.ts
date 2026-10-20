import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/server/auth/password';
import { FailureLimiter, RequestLimiter } from '../../src/server/auth/rate-limit';

describe('password hashing (scrypt)', () => {
  it('verifies the right password only', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^scrypt:32768:8:1:[\w-]+:[\w-]+$/);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('correct horsE', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });

  it('rejects malformed hashes and short passwords', async () => {
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
    expect(await verifyPassword('x', 'scrypt:a:b:c:d:e')).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow();
  });
});

describe('request limiter (sign-in routes)', () => {
  const opts = { windowMs: 60_000, maxPerKey: 2, maxGlobal: 3, maxKeys: 2 };

  it('caps per key and globally, then resets after the window', () => {
    const limiter = new RequestLimiter(opts);
    const t = 1_000_000;
    expect(limiter.take('a', t)).toBe(true);
    expect(limiter.take('a', t)).toBe(true);
    expect(limiter.take('a', t)).toBe(false);
    expect(limiter.take('b', t)).toBe(true);
    expect(limiter.take('b', t)).toBe(false); // global ceiling (3) reached
    expect(limiter.take('a', t + 60_000)).toBe(true);
  });

  it('bounds memory: refuses new keys instead of evicting live ones', () => {
    const limiter = new RequestLimiter({ ...opts, maxGlobal: 100 });
    const t = 1_000_000;
    expect(limiter.take('a', t)).toBe(true);
    expect(limiter.take('b', t)).toBe(true);
    expect(limiter.take('c', t)).toBe(false);
    expect(limiter.size).toBe(2);
    expect(limiter.take('c', t + 60_000)).toBe(true); // expired keys are swept first
  });
});

describe('login rate limit', () => {
  const opts = { windowMs: 60_000, maxPerKey: 3, maxGlobal: 5 };

  it('blocks a client after N failures until the window passes', () => {
    const limiter = new FailureLimiter(opts);
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(limiter.retryAfter('ip-a', t + i)).toBe(0);
      limiter.recordFailure('ip-a', t + i);
    }
    expect(limiter.retryAfter('ip-a', t + 10)).toBe(60);
    expect(limiter.retryAfter('ip-b', t + 10)).toBe(0);
    expect(limiter.retryAfter('ip-a', t + 60_001)).toBe(0);
  });

  it('success clears the client; a global ceiling still applies', () => {
    const limiter = new FailureLimiter(opts);
    const t = 1_000_000;
    limiter.recordFailure('ip-a', t);
    limiter.recordSuccess('ip-a');
    expect(limiter.retryAfter('ip-a', t)).toBe(0);
    // ip-a's failure still counts globally: 1 + 3 = 4 < 5
    for (const ip of ['1', '2', '3']) limiter.recordFailure(ip, t);
    expect(limiter.retryAfter('fresh', t)).toBe(0);
    limiter.recordFailure('4', t);
    expect(limiter.retryAfter('fresh', t)).toBeGreaterThan(0);
  });
});
