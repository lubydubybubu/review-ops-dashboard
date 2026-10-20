import { createHash, randomBytes } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { describe, expect, it } from 'vitest';
import { brandMatcher, buildMailNotes, escapeMarkdown, gmailMessageUrl, matchBrand } from '../../src/lib/mail';
import { directIngestCheck, type DirectIngestCheck } from '../../src/server/ingest/origin';
import {
  IngestConfigError,
  parseCidrList,
  peerAllowed,
  readIngestConfig,
  tokenKey,
  verifyBearer,
} from '../../src/server/ingest/config';
import { peerAddress } from '../../src/server/ingest/peer';
import { invalidFields, MAIL_CAPS, mailCandidateSchema } from '../../src/server/ingest/schema';
import { candidatePayload, INJECTION } from '../fixtures/mail';

const parse = (v: unknown) => mailCandidateSchema.safeParse(v);
const ok = (v: unknown) => parse(v).success;
const s = (n: number) => '가'.repeat(n);

describe('ingest schema: caps and strictness', () => {
  it('accepts the synthetic payload and lowercases ids', () => {
    const upper = candidatePayload({ message_id: '18F2A0B1C2D3E4F5', thread_id: '18F2A0B1C2D3E4F5' });
    const result = parse(upper);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ message_id: '18f2a0b1c2d3e4f5', thread_id: '18f2a0b1c2d3e4f5' });
  });

  it('enforces every length cap at exactly the limit', () => {
    const cases: [string, (n: number) => unknown, number][] = [
      ['subject', (n) => candidatePayload({ subject: s(n) }), MAIL_CAPS.subject],
      ['snippet', (n) => candidatePayload({ snippet: s(n) }), MAIL_CAPS.snippet],
      ['from_name', (n) => candidatePayload({ from_name: s(n) }), MAIL_CAPS.fromName],
      ['brand', (n) => candidatePayload({ extracted: { brand_name: s(n) } }), MAIL_CAPS.brandName],
      ['product', (n) => candidatePayload({ extracted: { product_name: s(n) } }), MAIL_CAPS.productName],
      ['notes', (n) => candidatePayload({ extracted: { notes: s(n) } }), MAIL_CAPS.notes],
      ['evidence line', (n) => candidatePayload({ evidence: [s(n)] }), MAIL_CAPS.evidenceLine],
      ['evidence lines', (n) => candidatePayload({ evidence: Array.from({ length: n }, () => '근거') }), MAIL_CAPS.evidenceLines],
    ];
    for (const [name, make, cap] of cases) {
      expect([name, ok(make(cap))]).toEqual([name, true]);
      expect([name, ok(make(cap + 1))]).toEqual([name, false]);
    }
    expect([MAIL_CAPS.snippet, MAIL_CAPS.notes, MAIL_CAPS.evidenceLines]).toEqual([1000, 500, 5]);
  });

  it('refuses unknown keys at every level, wrong enums, ranges and shapes', () => {
    const base = candidatePayload();
    expect(ok({ ...base, html: '<p>' })).toBe(false);
    expect(ok({ ...base, extracted: { ...base.extracted, price: 1 } })).toBe(false);
    expect(ok({ ...base, extracted: { ...base.extracted, deadlines: { ...base.extracted.deadlines, ship_by: null } } })).toBe(false);
    expect(ok({ ...base, source: 'outlook' })).toBe(false);
    expect(ok({ ...base, extracted: { ...base.extracted, source_type: 'rental' } })).toBe(false);
    expect(ok({ ...base, confidence: -0.01 })).toBe(false);
    expect(ok({ ...base, confidence: 1.01 })).toBe(false);
    expect(ok({ ...base, confidence: '0.9' })).toBe(false);
    expect(ok({ ...base, message_id: 'not-hex-at-all' })).toBe(false);
    expect(ok({ ...base, message_id: '1234567' })).toBe(false);
    expect(ok({ ...base, thread_id: `${'a'.repeat(65)}` })).toBe(false);
    expect(ok({ ...base, received_at: 'yesterday' })).toBe(false);
    expect(ok({ ...base, received_at: '1999-12-31T23:00:00Z' })).toBe(false);
    expect(ok({ ...base, from_address: 'no-at-sign' })).toBe(false);
    expect(ok({ ...base, from_address: 'a@b.example>, <c@d.example' })).toBe(false);
    expect(ok({ ...base, extracted: { ...base.extracted, deadlines: { ...base.extracted.deadlines, publish: '2026-02-30' } } })).toBe(false);
    expect(ok({ ...base, extracted: { ...base.extracted, deadlines: { ...base.extracted.deadlines, write_by: '2026-10-30T00:00' } } })).toBe(false);
    expect(ok({ ...base, evidence: [''] })).toBe(false);
    expect(ok([base])).toBe(false);
  });

  it('refuses control and bidi-override characters; newlines only in multi-line fields', () => {
    const base = candidatePayload();
    expect(ok({ ...base, snippet: 'a\u0000b' })).toBe(false);
    expect(ok({ ...base, subject: 'evil‮txt.exe' })).toBe(false);
    expect(ok({ ...base, subject: 'two\nlines' })).toBe(false);
    expect(ok({ ...base, evidence: ['a\rb'] })).toBe(false);
    expect(ok({ ...base, snippet: 'two\nlines\tok' })).toBe(true);
    expect(ok({ ...base, extracted: { ...base.extracted, notes: 'line 1\nline 2' } })).toBe(true);
  });

  it('missing nullable fields mean null; injection-shaped text is just text', () => {
    const { from_name: _f, snippet: _s, evidence: _e, ...rest } = candidatePayload();
    const minimal = { ...rest, extracted: { source_type: 'unknown', deadlines: {} } };
    const result = parse(minimal);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      from_name: null,
      snippet: '',
      evidence: [],
      extracted: { brand_name: null, product_name: null, notes: null, deadlines: { write_by: null, publish: null, embargo: null, return_by: null } },
    });
    const injected = parse(candidatePayload({ subject: INJECTION.subject, snippet: INJECTION.snippet, evidence: [INJECTION.evidence] }));
    expect(injected.success).toBe(true);
    expect(injected.data?.subject).toBe(INJECTION.subject);
  });

  it('400 details name fields only — never values, never unknown key names', () => {
    const secretish = 'SECRET-VALUE-123';
    const result = parse({ ...candidatePayload({ subject: s(501) }), [secretish]: secretish });
    expect(result.success).toBe(false);
    const fields = invalidFields(result.error!);
    expect(fields).toContain('subject');
    expect(fields).toContain('(root): unknown key');
    expect(JSON.stringify(fields)).not.toContain(secretish);
    expect(JSON.stringify(fields)).not.toContain('가가가');
  });
});

describe('ingest token check', () => {
  const token = randomBytes(32).toString('base64url');
  const hashHex = createHash('sha256').update(token).digest('hex');
  const hash = Buffer.from(hashHex, 'hex');

  it('accepts exactly the right bearer token', () => {
    expect(verifyBearer(`Bearer ${token}`, hash)).toBe(true);
    expect(verifyBearer(`bearer ${token}`, hash)).toBe(true);
  });

  it('refuses wrong, missing, empty, hash-only and malformed credentials', () => {
    const other = randomBytes(32).toString('base64url');
    expect(verifyBearer(`Bearer ${other}`, hash)).toBe(false); // wrong
    expect(verifyBearer(`Bearer ${token.slice(0, -1)}x`, hash)).toBe(false); // one char off
    expect(verifyBearer(null, hash)).toBe(false); // missing
    expect(verifyBearer('', hash)).toBe(false); // empty header
    expect(verifyBearer('Bearer ', hash)).toBe(false); // empty token
    expect(verifyBearer('Bearer', hash)).toBe(false);
    expect(verifyBearer(`Bearer ${hashHex}`, hash)).toBe(false); // the stored hash is not a credential
    expect(verifyBearer(`Basic ${token}`, hash)).toBe(false);
    expect(verifyBearer(`Bearer ${token} extra`, hash)).toBe(false);
    expect(verifyBearer(`Bearer  ${token}`, hash)).toBe(false);
    expect(verifyBearer(`Bearer ${'a'.repeat(20)}`, hash)).toBe(false); // too short to be a token
    expect(verifyBearer(`Bearer ${token}`, Buffer.alloc(0))).toBe(false); // no hash configured
  });

  it('config: off without a hash, refuses malformed values without echoing them, reads the secret file', () => {
    const noFile = () => {
      throw new Error('no file');
    };
    const err = (env: Record<string, string>) => {
      try {
        readIngestConfig(env, noFile);
        return 'ok';
      } catch (e) {
        expect(e).toBeInstanceOf(IngestConfigError);
        return (e as Error).message;
      }
    };
    expect(err({})).toMatch(/disabled/);
    expect(err({ OPS_INGEST_TOKEN_SHA256: token })).toMatch(/64 hex/); // the token itself is not a hash
    expect(err({ OPS_INGEST_TOKEN_SHA256: token })).not.toContain(token);
    expect(err({ OPS_INGEST_TOKEN_SHA256_FILE: '/nope' })).toMatch(/not readable/);
    expect(err({ OPS_INGEST_TOKEN_SHA256: hashHex, OPS_INGEST_RATE_PER_MINUTE: '0' })).toMatch(/RATE/);
    expect(err({ OPS_INGEST_TOKEN_SHA256: hashHex, OPS_INGEST_ALLOWED_CIDRS: '10.0.0.0/33' })).toMatch(/CIDR/);
    expect(err({ OPS_INGEST_TOKEN_SHA256: hashHex, OPS_INGEST_ALLOWED_CIDRS: 'lan' })).toMatch(/CIDR/);

    const fromFile = readIngestConfig({ OPS_INGEST_TOKEN_SHA256_FILE: '/run/secrets/x' }, () => `${hashHex.toUpperCase()}\n`);
    expect(fromFile.tokenHash.equals(hash)).toBe(true);
    expect(fromFile.allow).toBeNull();
    expect(fromFile.ratePerMinute).toBe(60);
    expect(tokenKey(hash)).not.toContain(hashHex);
  });

  it('allowlist: socket peer in CIDR (v4, v4-mapped v6, v6); forwarded headers are never consulted', () => {
    const allow = parseCidrList(' 198.51.100.0/24, 10.0.0.7/32 , fd00::/8')!;
    expect(peerAllowed(allow, '198.51.100.44')).toBe(true);
    expect(peerAllowed(allow, '::ffff:198.51.100.44')).toBe(true);
    expect(peerAllowed(allow, '10.0.0.7')).toBe(true);
    expect(peerAllowed(allow, 'fd12::1')).toBe(true);
    expect(peerAllowed(allow, '10.0.0.8')).toBe(false);
    expect(peerAllowed(allow, '127.0.0.1')).toBe(false);
    expect(peerAllowed(allow, null)).toBe(false);
    expect(peerAllowed(allow, 'not-an-ip')).toBe(false);
    expect(parseCidrList('')).toBeNull();
    // without the preload in this process the stamped header is not trusted (it could be forged)
    const forged = new Headers({ 'x-ops-peer-address': '198.51.100.44', 'x-forwarded-for': '198.51.100.44' });
    expect(peerAddress(forged)).toBeNull();
  });
});

describe('ingest direct-host gate (OPS_INGEST_ALLOWED_HOST)', () => {
  const allowed = '192.0.2.10:3000';
  it('allows only the exact direct host without Cloudflare markers; fails closed when unset', () => {
    const cases: [string, Record<string, string>, string | undefined, DirectIngestCheck][] = [
      ['direct LAN', { host: allowed }, allowed, 'ok'],
      ['public Host', { host: 'ops.site.example' }, allowed, 'refused'],
      ['public Host even with private forwarded Host', { host: 'ops.site.example', 'x-forwarded-host': allowed }, allowed, 'refused'],
      ['tunnel rewrites Host but cf-connecting-ip survives', { host: allowed, 'cf-connecting-ip': '203.0.113.7' }, allowed, 'refused'],
      ['tunnel rewrites Host but cf-ray survives', { host: allowed, 'cf-ray': 'synthetic' }, allowed, 'refused'],
      ['empty cf-connecting-ip still denied', { host: allowed, 'cf-connecting-ip': '' }, allowed, 'refused'],
      ['empty cf-ray still denied', { host: allowed, 'cf-ray': '' }, allowed, 'refused'],
      ['missing Host', {}, allowed, 'refused'],
      ['unconfigured allowed Host', { host: allowed }, undefined, 'unset'],
      ['blank allowed Host', { host: allowed }, '  ', 'unset'],
      ['suffix lookalike', { host: `${allowed}.evil.test` }, allowed, 'refused'],
      ['wrong port', { host: '192.0.2.10:3100' }, allowed, 'refused'],
      ['no port', { host: '192.0.2.10' }, allowed, 'refused'],
      ['case differs (exact match only)', { host: 'OPS.example:3000' }, 'ops.example:3000', 'refused'],
    ];
    for (const [name, headers, config, expected] of cases) {
      expect([name, directIngestCheck(new Headers(headers), config)]).toEqual([name, expected]);
    }
  });
});

describe('gmail link and plain-text handling', () => {
  it('builds the link only from a hex message id', () => {
    expect(gmailMessageUrl('18f2a0b1c2d3e4f5')).toBe('https://mail.google.com/mail/u/0/#all/18f2a0b1c2d3e4f5');
    for (const bad of [
      'javascript:alert(1)',
      '18f2a0b1c2d3e4f5/../../evil',
      '18f2a0b1c2d3e4f5?x=1',
      '18f2a0b1c2d3e4f5#x',
      ' 18f2a0b1c2d3e4f5',
      '18F2A0B1C2D3E4F5',
      '18f2a0g1c2d3e4f5',
      'https://evil.example',
      '',
      'abc',
      'a'.repeat(65),
      null,
      42,
      ['18f2a0b1c2d3e4f5'],
    ]) {
      expect([bad, gmailMessageUrl(bad)]).toEqual([bad, null]);
    }
  });

  it('mail text in review notes renders as the literal characters (no image fetch, link, HTML or heading)', () => {
    const notes = buildMailNotes(
      {
        fromName: INJECTION.fromName,
        fromAddress: 'pr@evil.example',
        subject: INJECTION.product,
        receivedAt: '2026-10-19T16:30:00.000Z',
        messageId: '18f2a0b1c2d3e4f5',
      },
      `${INJECTION.notes}\n${INJECTION.subject}`,
    );
    const html = renderToStaticMarkup(createElement(Markdown, null, notes));
    expect(html).not.toMatch(/<img|<iframe|<script|<svg|<strong|<code|href="javascript|src="|<h2>제목/);
    expect(html.match(/<a /g)).toHaveLength(1); // only the Gmail link the app built
    expect(html).toContain('<h2>메일에서 온 의뢰</h2>');
    expect(html).toContain('받은 날: 2026-10-20'); // KST day of the instant
    expect(html).toContain('href="https://mail.google.com/mail/u/0/#all/18f2a0b1c2d3e4f5"');
    // the text survives, just escaped
    expect(html).toContain('![x](https://tracker.example/p.png)');
    expect(html).toContain('&lt;iframe');
    expect(escapeMarkdown('*a* _b_ [c](d) <e>')).toBe('\\*a\\* \\_b\\_ \\[c\\]\\(d\\) \\<e\\>');
  });

  it('matches an existing brand case-insensitively', () => {
    const brands = [{ id: 1, name: 'Northwind' }, { id: 2, name: 'Kestrel Audio' }];
    expect(matchBrand(brands, '  northwind ')?.id).toBe(1);
    expect(matchBrand(brands, 'KESTREL AUDIO')?.id).toBe(2);
    expect(matchBrand(brands, 'Kestrel')).toBeUndefined();
    expect(matchBrand(brands, null)).toBeUndefined();
    expect(matchBrand(brands, '   ')).toBeUndefined();
  });

  it('brandMatcher (one index per inbox render) gives exactly matchBrand’s result, first match winning', () => {
    const brands = [
      ...Array.from({ length: 500 }, (_, i) => ({ id: i + 1, name: `Brand ${i}` })),
      { id: 900, name: ' brand 7 ' }, // same key as id 8: the earlier one wins, as with find()
      { id: 901, name: '   ' },
      { id: 902, name: 'Kestrel Audio' },
    ];
    const names = [...Array.from({ length: 200 }, (_, i) => ` BRAND ${i * 3} `), 'brand 7', 'kestrel audio', 'Kestrel', '', '   ', null];
    const find = brandMatcher(brands);
    for (const name of names) expect([name, find(name)?.id]).toEqual([name, matchBrand(brands, name)?.id]);
    expect(find('brand 7')?.id).toBe(8);
    expect(brandMatcher([])('x')).toBeUndefined();
  });
});
