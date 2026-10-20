/**
 * npm run ingest-token -- --out <path>
 *
 * Creates the mail producer's bearer token: 32 random bytes (base64url) written to <path> with mode
 * 0600 (the file is never overwritten), and prints only its SHA-256 — the value Ops gets
 * (OPS_INGEST_TOKEN_SHA256 or the file behind OPS_INGEST_TOKEN_SHA256_FILE). Run it on the producer's
 * host and copy just the printed hash to the Ops host: the token itself never leaves that host.
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const outIndex = process.argv.indexOf('--out');
const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
if (!out) {
  console.error('usage: npm run ingest-token -- --out <path to the new token file>');
  process.exit(2);
}

const token = randomBytes(32).toString('base64url');
try {
  writeFileSync(out, `${token}\n`, { mode: 0o600, flag: 'wx' });
} catch (error) {
  console.error(`could not create ${out}: ${(error as NodeJS.ErrnoException).code ?? 'error'} (an existing file is never overwritten)`);
  process.exit(1);
}
console.log(`token written to ${out} (mode 0600)`);
console.log(`OPS_INGEST_TOKEN_SHA256=${createHash('sha256').update(token).digest('hex')}`);
