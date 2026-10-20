/**
 * The TCP peer address of a request, as stamped by scripts/peer-address.mjs. Trusted only when that
 * preload runs in this process (its marker is set): it overwrites the header on every request, so a
 * client cannot choose the value. Without the preload the header could be forged, so this returns
 * null and an allowlist refuses everything.
 */
export const PEER_HEADER = 'x-ops-peer-address';
const MARKER = Symbol.for('review-ops.peer-address-stamp');

export function peerStampInstalled(): boolean {
  return (globalThis as Record<symbol, unknown>)[MARKER] === true;
}

export function peerAddress(headers: Pick<Headers, 'get'>): string | null {
  if (!peerStampInstalled()) return null;
  const value = headers.get(PEER_HEADER)?.trim();
  return value && value.length <= 64 ? value : null;
}
