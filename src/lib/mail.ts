/**
 * Mail review requests ("메일 의뢰"): shared shapes and pure helpers. No zod here: client components
 * import this file; the ingest schema lives in src/server/ingest/schema.ts.
 *
 * Everything that came from a mail is untrusted text. It is shown as plain text only (React text
 * nodes, never HTML or markdown), and the only value a link is ever built from is the mailbox
 * message id, after checking that it is hex.
 */
import { kstDateOf, type IsoDate, type IsoInstant } from './domain/dates';

export const MAIL_SOURCES = ['gmail'] as const;
export type MailSource = (typeof MAIL_SOURCES)[number];

export const MAIL_SOURCE_TYPES = ['loan', 'gift', 'purchase', 'unknown'] as const;
export type MailSourceType = (typeof MAIL_SOURCE_TYPES)[number];
export const MAIL_SOURCE_TYPE_LABEL: Record<MailSourceType, string> = {
  loan: '대여',
  gift: '제공',
  purchase: '구매',
  unknown: '미정',
};

export const MAIL_DEADLINES = ['write_by', 'publish', 'embargo', 'return_by'] as const;
export type MailDeadline = (typeof MAIL_DEADLINES)[number];
export const MAIL_DEADLINE_LABEL: Record<MailDeadline, string> = {
  write_by: '작성 마감',
  publish: '발행',
  embargo: '엠바고',
  return_by: '반납',
};

export interface MailExtracted {
  brand_name: string | null;
  product_name: string | null;
  source_type: MailSourceType;
  deadlines: Record<MailDeadline, IsoDate | null>;
  notes: string | null;
}

export const MAIL_STATUSES = ['pending', 'accepted', 'dismissed', 'duplicate'] as const;
export type MailStatus = (typeof MAIL_STATUSES)[number];

export interface MailCandidate {
  id: number;
  source: MailSource;
  messageId: string;
  threadId: string;
  receivedAt: IsoInstant;
  fromName: string | null;
  fromAddress: string;
  subject: string;
  snippet: string;
  extracted: MailExtracted;
  evidence: string[];
  confidence: number;
  status: MailStatus;
  reviewId: number | null;
  /** product name of the linked review (duplicate / accepted), for "같은 스레드 새 메일" */
  reviewName: string | null;
  createdAt: IsoInstant;
  decidedAt: IsoInstant | null;
  version: number;
}

/** Open candidates per inbox page (older ones: 더 보기). */
export const MAIL_INBOX_PAGE = 200;

/** A dismissed candidate can be restored for this long. */
export const MAIL_UNDO_DAYS = 7;

export const MAIL_STALE_MESSAGE = '다른 곳에서 이미 처리했거나 바뀐 메일 의뢰입니다. 새로고침 후 다시 확인하세요.';
export const MAIL_UNDO_EXPIRED_MESSAGE = `무시한 지 ${MAIL_UNDO_DAYS}일이 지나 되돌릴 수 없습니다.`;

/** Gmail message / thread ids: lowercase hex. */
export const MAIL_ID_RE = /^[0-9a-f]{8,64}$/;

/**
 * The only mail link the app builds: `https://mail.google.com/mail/u/0/#all/<message id>`. Anything
 * that is not a plain hex id (URL parts, `javascript:`, whitespace, other mailbox ids) gives null.
 */
export function gmailMessageUrl(messageId: unknown): string | null {
  if (typeof messageId !== 'string' || !MAIL_ID_RE.test(messageId)) return null;
  return `https://mail.google.com/mail/u/0/#all/${messageId}`;
}

/**
 * Untrusted text placed into a markdown document (review notes) as literal text: every character
 * markdown could treat as syntax is backslash-escaped, so links, images (remote fetches), HTML and
 * headings from a mail all render as the characters they are.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+\-.!|~&:"'=$%@^]/g, (c) => `\\${c}`);
}

/**
 * The "메일에서 온 의뢰" section appended to a review created from a mail. Sender and subject come
 * from the stored candidate, the memo from the owner's form; all of it is escaped (literal text).
 * The Gmail link is built here from the validated id, never taken from mail text.
 */
export function buildMailNotes(
  candidate: Pick<MailCandidate, 'fromName' | 'fromAddress' | 'subject' | 'receivedAt' | 'messageId'>,
  memo: string,
): string {
  const sender = candidate.fromName ? `${candidate.fromName} (${candidate.fromAddress})` : candidate.fromAddress;
  const lines = [
    '## 메일에서 온 의뢰',
    `- 보낸 사람: ${escapeMarkdown(sender)}`,
    `- 제목: ${escapeMarkdown(candidate.subject || '(제목 없음)')}`,
    `- 받은 날: ${kstDateOf(candidate.receivedAt)}`,
  ];
  const url = gmailMessageUrl(candidate.messageId);
  if (url) lines.push(`- Gmail: <${url}>`);
  const memoLines = memo
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => escapeMarkdown(l));
  if (memoLines.length > 0) lines.push('', memoLines.join('  \n'));
  return lines.join('\n');
}

const brandKey = (name: string | null | undefined) => name?.trim().toLowerCase() || undefined;

/** Case-insensitive, whitespace-trimmed brand match (the brands table is unique on lower(name)). */
export function matchBrand<B extends { name: string }>(brands: readonly B[], name: string | null): B | undefined {
  const key = brandKey(name);
  if (!key) return undefined;
  return brands.find((b) => brandKey(b.name) === key);
}

/**
 * `matchBrand` for many names at once (one inbox render): normalize the brand list once, then each
 * lookup is O(1). Same rule and same result, including the first brand winning on a tie.
 */
export function brandMatcher<B extends { name: string }>(brands: readonly B[]): (name: string | null) => B | undefined {
  const index = new Map<string, B>();
  for (const b of brands) {
    const key = brandKey(b.name);
    if (key && !index.has(key)) index.set(key, b);
  }
  return (name) => {
    const key = brandKey(name);
    return key ? index.get(key) : undefined;
  };
}
