// Preload for the Ops server process: `node --import ./peer-address.mjs server.js` (Dockerfile) or
// NODE_OPTIONS=--import <file URL> for `next start` (e2e/run.ts).
//
// Next.js does not give route handlers the TCP peer address, and the `x-forwarded-for` it adds keeps
// any value the client sent. This stamps every incoming request with the socket's remote address under
// one header, always overwriting whatever the client put there, before Next.js sees the request.
// The ingest allowlist (OPS_INGEST_ALLOWED_CIDRS) trusts that header only when the marker below is set,
// i.e. only when this preload really runs in the same process; otherwise it refuses every request.
import http from 'node:http';

const HEADER = 'x-ops-peer-address';
const MARKER = Symbol.for('review-ops.peer-address-stamp');

if (!globalThis[MARKER]) {
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emitWithPeerAddress(event, ...args) {
    if (event === 'request' && args[0]?.headers) {
      args[0].headers[HEADER] = args[0].socket?.remoteAddress ?? '';
    }
    return emit.call(this, event, ...args);
  };
  globalThis[MARKER] = true;
}
