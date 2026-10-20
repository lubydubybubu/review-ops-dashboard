import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';

/**
 * Configuration of the mail-candidate ingest endpoint (POST /api/ingest/mail-candidates), read from
 * the environment. Read lazily, never at import time. Problems are reported as fixed text, never
 * a value. Ingest is off unless a token hash is configured; it is never on by accident.
 *
 * OPS_INGEST_TOKEN_SHA256_FILE   file holding the SHA-256 (64 hex) of the producer's bearer token
 * OPS_INGEST_TOKEN_SHA256        the same, inline (the file wins when both are set)
 * OPS_INGEST_ALLOWED_CIDRS       optional comma-separated CIDR list; checked against the TCP peer
 *                                address (scripts/peer-address.mjs), never against forwarded headers
 * OPS_INGEST_RATE_PER_MINUTE     accepted requests per minute for the token (default 60, 1–600)
 * OPS_INGEST_ALLOWED_HOST        required: the exact Host of the direct LAN path (host:port). Checked
 *                                first, by the route itself (origin.ts), not here; unset refuses all.
 *
 * Only the hash is stored anywhere on the Ops side. The token itself lives on the producer's host.
 */

export interface IngestConfig {
  /** SHA-256 of the bearer token (32 bytes) */
  tokenHash: Buffer;
  /** null = no allowlist */
  allow: BlockList | null;
  ratePerMinute: number;
}

export class IngestConfigError extends Error {
  override name = 'IngestConfigError';
}

type Env = Record<string, string | undefined>;

const HASH_RE = /^[0-9a-f]{64}$/;
/** What a producer token looks like: 32+ random bytes, base64url (43+ chars). */
export const INGEST_TOKEN_RE = /^[A-Za-z0-9_-]{43,128}$/;

export function readIngestConfig(env: Env = process.env, readFile = (p: string) => readFileSync(p, 'utf8')): IngestConfig {
  let hash: string | undefined;
  if (env.OPS_INGEST_TOKEN_SHA256_FILE) {
    try {
      hash = readFile(env.OPS_INGEST_TOKEN_SHA256_FILE).trim().toLowerCase();
    } catch {
      throw new IngestConfigError('OPS_INGEST_TOKEN_SHA256_FILE is not readable');
    }
  } else {
    hash = env.OPS_INGEST_TOKEN_SHA256?.trim().toLowerCase();
  }
  if (!hash) throw new IngestConfigError('ingest is disabled (no OPS_INGEST_TOKEN_SHA256[_FILE])');
  if (!HASH_RE.test(hash)) throw new IngestConfigError('ingest token hash must be 64 hex characters (SHA-256)');

  const rate = env.OPS_INGEST_RATE_PER_MINUTE?.trim();
  const ratePerMinute = rate ? Number(rate) : 60;
  if (!Number.isInteger(ratePerMinute) || ratePerMinute < 1 || ratePerMinute > 600) {
    throw new IngestConfigError('OPS_INGEST_RATE_PER_MINUTE must be an integer in [1, 600]');
  }

  return { tokenHash: Buffer.from(hash, 'hex'), allow: parseCidrList(env.OPS_INGEST_ALLOWED_CIDRS), ratePerMinute };
}

/** `10.0.0.5/32, 198.51.100.0/24, fd00::/8` → BlockList; empty → null; anything malformed throws. */
export function parseCidrList(value: string | undefined): BlockList | null {
  const entries = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  if (entries.length > 64) throw new IngestConfigError('OPS_INGEST_ALLOWED_CIDRS has too many entries');
  const list = new BlockList();
  for (const entry of entries) {
    const m = /^([^/\s]+)\/(\d{1,3})$/.exec(entry);
    const family = m ? isIP(m[1]!) : 0;
    const prefix = m ? Number(m[2]) : NaN;
    if (!m || family === 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new IngestConfigError('OPS_INGEST_ALLOWED_CIDRS must be a comma-separated list of address/prefix');
    }
    list.addSubnet(m[1]!, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

/** Is a socket peer address inside the allowlist? IPv4-mapped IPv6 (`::ffff:10.0.0.5`) counts as IPv4. */
export function peerAllowed(allow: BlockList, address: string | null): boolean {
  if (!address) return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  const family = isIP(ip);
  if (family === 0) return false;
  return allow.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * `Authorization: Bearer <token>` against the stored hash. The presented token is hashed and the two
 * 32-byte digests are compared with timingSafeEqual, so timing does not depend on how much matched.
 * Missing, empty, non-Bearer, oddly shaped, or the hash itself → false.
 */
export function verifyBearer(authorization: string | null, tokenHash: Buffer): boolean {
  if (!authorization || tokenHash.length !== 32) return false;
  const m = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!m || !INGEST_TOKEN_RE.test(m[1]!)) return false;
  const presented = createHash('sha256').update(m[1]!).digest();
  return timingSafeEqual(presented, tokenHash);
}

/** Short, stable rate-limit key for the token (never the token or its full hash in memory maps or logs). */
export function tokenKey(tokenHash: Buffer): string {
  return `token:${tokenHash.subarray(0, 6).toString('hex')}`;
}

const globalForConfig = globalThis as unknown as { opsIngestConfig?: IngestConfig };

/** Process-wide config; only a successful read is cached. */
export function getIngestConfig(): IngestConfig {
  return (globalForConfig.opsIngestConfig ??= readIngestConfig());
}
