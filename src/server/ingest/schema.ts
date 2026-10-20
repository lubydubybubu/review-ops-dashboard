import { z } from 'zod';
import { isIsoDate } from '@/lib/domain/dates';
import { MAIL_ID_RE, MAIL_SOURCE_TYPES, MAIL_SOURCES, type MailDeadline } from '@/lib/mail';

/**
 * One mail candidate as the producer POSTs it (snake_case JSON). Strict: unknown keys, wrong types,
 * oversized strings, control / bidi-override characters and out-of-range dates are refused (400),
 * never trimmed or coerced into something else. The caps mirror the table's CHECK constraints.
 */

/** C0/C1 controls (except tab/newline where allowed), DEL, bidi overrides/isolates, BOM. */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/;
const LINE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/;

/** Single-line text (names, subject, evidence lines). */
const line = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !LINE_CONTROL_RE.test(v), 'control characters are not allowed');

/** Multi-line text (snippet, notes): tab and newlines allowed. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => !CONTROL_RE.test(v), 'control characters are not allowed');

/** Mailbox ids are hex; stored lowercase so (source, message_id) dedupe is exact. */
const mailId = z
  .string()
  .max(64)
  .transform((v) => v.toLowerCase())
  .refine((v) => MAIL_ID_RE.test(v), 'expected a hex id');

/** A deadline the mail states, or null (a missing key means null too). */
const date = z
  .string()
  .refine((v) => isIsoDate(v) && v >= '2000-01-01' && v <= '2999-12-31', 'expected YYYY-MM-DD')
  .nullable()
  .default(null);

const instant = z
  .string()
  .max(40)
  .pipe(z.iso.datetime({ offset: true }))
  .refine((v) => {
    const t = Date.parse(v);
    return Number.isFinite(t) && t >= Date.UTC(2000, 0, 1) && t < Date.UTC(3000, 0, 1);
  }, 'out of range');

const emailAddress = z
  .string()
  .min(3)
  .max(320)
  .refine((v) => /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+$/.test(v), 'expected an address');

export const MAIL_CAPS = {
  fromName: 200,
  subject: 500,
  snippet: 1000,
  brandName: 120,
  productName: 200,
  notes: 500,
  evidenceLines: 5,
  evidenceLine: 300,
} as const;

export const mailCandidateSchema = z
  .object({
    source: z.enum(MAIL_SOURCES),
    message_id: mailId,
    thread_id: mailId,
    received_at: instant,
    from_name: line(MAIL_CAPS.fromName).nullable().default(null),
    from_address: emailAddress,
    subject: line(MAIL_CAPS.subject),
    snippet: text(MAIL_CAPS.snippet).default(''),
    extracted: z
      .object({
        brand_name: line(MAIL_CAPS.brandName).nullable().default(null),
        product_name: line(MAIL_CAPS.productName).nullable().default(null),
        source_type: z.enum(MAIL_SOURCE_TYPES),
        deadlines: z
          .object({ write_by: date, publish: date, embargo: date, return_by: date } satisfies Record<MailDeadline, typeof date>)
          .strict(),
        notes: text(MAIL_CAPS.notes).nullable().default(null),
      })
      .strict(),
    evidence: z.array(line(MAIL_CAPS.evidenceLine).min(1)).max(MAIL_CAPS.evidenceLines).default([]),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type MailCandidateInput = z.output<typeof mailCandidateSchema>;

/** Paths of the fields that failed, for the 400 body. Never values; unknown keys are not named either. */
export function invalidFields(error: z.ZodError): string[] {
  const paths = error.issues.map((i) => (i.code === 'unrecognized_keys' ? `${i.path.join('.') || '(root)'}: unknown key` : i.path.join('.') || '(root)'));
  return [...new Set(paths)].slice(0, 10);
}
