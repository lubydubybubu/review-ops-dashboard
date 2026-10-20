/**
 * Is this request on the direct LAN path to the ingest endpoint, not the public hostname?
 *
 * The public site (ops.site.example) arrives through a Cloudflare tunnel whose connector may sit on an
 * allowlisted address, so the socket peer alone cannot tell the two paths apart. This gate can:
 * - the raw `Host` header must equal OPS_INGEST_ALLOWED_HOST exactly (host:port, e.g.
 *   192.0.2.10:3000). X-Forwarded-Host is never consulted.
 * - neither `cf-connecting-ip` nor `cf-ray` may be present, even empty. These are a deny signal only:
 *   a direct caller can forge them only to refuse its own request.
 * Unset (or blank) OPS_INGEST_ALLOWED_HOST refuses everything: ingest fails closed.
 */
export type DirectIngestCheck = 'ok' | 'unset' | 'refused';

export function directIngestCheck(headers: Pick<Headers, 'get' | 'has'>, allowedHost: string | undefined): DirectIngestCheck {
  const allowed = allowedHost?.trim();
  if (!allowed) return 'unset';
  if (headers.get('host') !== allowed || headers.has('cf-connecting-ip') || headers.has('cf-ray')) return 'refused';
  return 'ok';
}
