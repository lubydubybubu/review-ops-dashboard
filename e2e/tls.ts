/**
 * E2E plumbing for real cookie rules: browsers only apply `Secure`, `__Host-` and schemeful
 * SameSite the way production does over https with real hostnames. So the E2E runs
 *
 *   https://site.test:<site port>        site fixture (synthetic, or another implementation)
 *   https://ops.site.test:<proxy port>   TLS proxy → `next start` on 127.0.0.1 (same-site with the site)
 *   https://evil.site.test:<proxy port>  attacker page on a same-site sibling host
 *   https://other.test:<proxy port>        attacker page on a different site
 *
 * with a throw-away CA generated per run (openssl), Chrome mapping only these hostnames to
 * loopback (everything else unresolvable), and the Ops server trusting the CA for its back channel.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const SITE_HOST = 'site.test';
export const OPS_HOST = 'ops.site.test';
export const SIBLING_HOST = 'evil.site.test';
export const CROSS_SITE_HOST = 'other.test';

export const CHROME_HOST_RULES = `--host-resolver-rules=MAP ${SITE_HOST} 127.0.0.1, MAP *.${SITE_HOST} 127.0.0.1, MAP ${CROSS_SITE_HOST} 127.0.0.1, MAP * ~NOTFOUND`;

export interface TestCertificates {
  dir: string;
  caFile: string;
  key: string;
  cert: string;
  cleanup(): Promise<void>;
}

/** A per-run CA and one leaf for all test hostnames. Keys stay in a temp dir that is removed afterwards. */
export async function createCertificates(): Promise<TestCertificates> {
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'e2e-tls-'));
  const f = (name: string) => path.join(dir, name);
  const run = (...args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '2', '-subj', '/CN=review-ops-e2e-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('leaf.key'), '-out', f('leaf.csr'), '-subj', `/CN=${SITE_HOST}`);
  await writeFile(f('leaf.ext'), `subjectAltName=DNS:${SITE_HOST},DNS:*.${SITE_HOST},DNS:${CROSS_SITE_HOST}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  run('x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('leaf.pem'), '-days', '2', '-extfile', f('leaf.ext'));
  return {
    dir,
    caFile: f('ca.pem'),
    key: await readFile(f('leaf.key'), 'utf8'),
    cert: await readFile(f('leaf.pem'), 'utf8'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export interface TlsFront {
  port: number;
  /** Names of every cookie the browser actually sent to the Ops host (what Chrome decided, not a cookie-jar query). */
  opsCookieNames: Set<string>;
  /** Serve this HTML at `path` on the attacker hosts (sibling + cross-site). */
  setPage(path: string, html: string): void;
  close(): Promise<void>;
}

/**
 * One TLS listener: Host ops.site.test → plain-HTTP proxy to `next start` (Host kept, so Next's
 * own Server Action origin check sees the public host); attacker hosts → static pages.
 */
export async function startTlsFront(certs: TestCertificates, upstreamPort: () => number): Promise<TlsFront> {
  const pages = new Map<string, string>();
  const opsCookieNames = new Set<string>();
  const server = https.createServer({ key: certs.key, cert: certs.cert }, (req, res) => {
    const host = String(req.headers.host ?? '').split(':')[0]!.toLowerCase();
    if (host === OPS_HOST) {
      for (const part of String(req.headers.cookie ?? '').split(';')) {
        const name = part.split('=')[0]!.trim();
        if (name) opsCookieNames.add(name);
      }
      const upstream = http.request(
        { host: '127.0.0.1', port: upstreamPort(), method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-proto': 'https' } },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
      return;
    }
    const html = (host === SIBLING_HOST || host === CROSS_SITE_HOST) && pages.get(new URL(req.url ?? '/', 'https://x.invalid').pathname);
    if (!html) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    opsCookieNames,
    setPage: (p, html) => void pages.set(p, html),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
