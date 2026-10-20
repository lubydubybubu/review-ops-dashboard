import { RequestLimiter } from '@/server/auth/rate-limit';
import { getPool } from '@/server/db/pool';
import { insertMailCandidate } from '@/server/db/mail';
import { getIngestConfig, IngestConfigError, peerAllowed, tokenKey, verifyBearer, type IngestConfig } from '@/server/ingest/config';
import { directIngestCheck } from '@/server/ingest/origin';
import { peerAddress } from '@/server/ingest/peer';
import { invalidFields, mailCandidateSchema } from '@/server/ingest/schema';

export const dynamic = 'force-dynamic';

/**
 * POST /api/ingest/mail-candidates — machine-to-machine, one mail candidate per request.
 *
 * The only route that accepts the producer's bearer token, and the token does nothing else: no
 * cookie is ever set here, no session is created, and every other page and API keeps requiring an
 * Ops session (the token is not a session token). It writes only `mail_candidates` rows.
 *
 * Order: direct host (OPS_INGEST_ALLOWED_HOST, no Cloudflare headers) → allowlist (socket peer) → token
 * → rate limit → size → JSON → schema → insert.
 * Responses are fixed JSON that never echo the input:
 *   201 created · 200 already stored (same source + message_id) · 400 invalid · 401 not allowed
 *   413 body over 64 KB · 429 too many requests (Retry-After) · 503 database unavailable
 */

const MAX_BODY_BYTES = 64 * 1024;
const WINDOW_MS = 60_000;
/** Failed attempts per peer per minute before 429 (a separate budget: failures never use the token's). */
const MAX_FAILURES_PER_PEER = 10;

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function reply(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

const globals = globalThis as unknown as { opsIngestLimits?: { rate: number; accepted: RequestLimiter; failed: RequestLimiter } };

function limiters(config: IngestConfig) {
  if (globals.opsIngestLimits?.rate !== config.ratePerMinute) {
    globals.opsIngestLimits = {
      rate: config.ratePerMinute,
      accepted: new RequestLimiter({ windowMs: WINDOW_MS, maxPerKey: config.ratePerMinute, maxGlobal: config.ratePerMinute, maxKeys: 4 }),
      failed: new RequestLimiter({ windowMs: WINDOW_MS, maxPerKey: MAX_FAILURES_PER_PEER, maxGlobal: 120, maxKeys: 1024 }),
    };
  }
  return globals.opsIngestLimits;
}

const tooMany = () => reply(429, { error: 'rate_limited' }, { 'retry-after': '60' });

/** Read at most `limit` bytes; null when the body is larger (stops reading at the limit). */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function POST(request: Request) {
  // first, before config / token / body: the public hostname (Cloudflare tunnel) never reaches ingest
  const origin = directIngestCheck(request.headers, process.env.OPS_INGEST_ALLOWED_HOST);
  if (origin !== 'ok') {
    console.error(origin === 'unset' ? 'ingest: refused, OPS_INGEST_ALLOWED_HOST is not set' : 'ingest: refused, not the direct ingest host');
    return reply(401, { error: 'unauthorized' });
  }

  let config: IngestConfig;
  try {
    config = getIngestConfig();
  } catch (error) {
    console.error(`ingest: ${error instanceof IngestConfigError ? error.message : 'configuration error'}`);
    return reply(401, { error: 'unauthorized' });
  }
  const peer = peerAddress(request.headers);
  const { accepted, failed } = limiters(config);
  const failure = () => (failed.take(`peer:${peer ?? 'unknown'}`) ? reply(401, { error: 'unauthorized' }) : tooMany());

  if (config.allow && !peerAllowed(config.allow, peer)) {
    console.error(peer ? 'ingest: refused, peer not in OPS_INGEST_ALLOWED_CIDRS' : 'ingest: refused, peer address unavailable (preload missing)');
    return failure();
  }
  if (!verifyBearer(request.headers.get('authorization'), config.tokenHash)) {
    console.error('ingest: refused, missing or wrong token');
    return failure();
  }
  if (!accepted.take(tokenKey(config.tokenHash))) return tooMany();

  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,12}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return reply(413, { error: 'too_large', maxBytes: MAX_BODY_BYTES });
  }
  if (!/^application\/json(\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
    return reply(400, { error: 'invalid', fields: ['(content-type)'] });
  }
  const bytes = await readCapped(request, MAX_BODY_BYTES);
  if (bytes === null) return reply(413, { error: 'too_large', maxBytes: MAX_BODY_BYTES });

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return reply(400, { error: 'invalid', fields: ['(json)'] });
  }
  const parsed = mailCandidateSchema.safeParse(raw);
  if (!parsed.success) return reply(400, { error: 'invalid', fields: invalidFields(parsed.error) });

  try {
    const outcome = await insertMailCandidate(getPool(), parsed.data);
    return outcome.created
      ? reply(201, { result: 'created', id: outcome.id, status: outcome.status })
      : reply(200, { result: 'exists', id: outcome.id });
  } catch (error) {
    // fixed tag only: the error could quote input values
    console.error(`ingest: insert failed (${(error as { code?: string }).code ?? 'unknown'})`);
    return reply(503, { error: 'unavailable' });
  }
}
