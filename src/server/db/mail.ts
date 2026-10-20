import { buildMailNotes, MAIL_INBOX_PAGE, MAIL_UNDO_DAYS, type MailCandidate, type MailStatus } from '@/lib/mail';
import type { Stage } from '@/lib/domain/review';
import type { MailAcceptInput } from '@/lib/validation';
import type { MailCandidateInput } from '../ingest/schema';
import { withTransaction, type Database, type Queryable } from './client';
import { createReviewInTx, NotFoundError } from './reviews';
import { listStages } from './stages';

/**
 * Mail review requests. The ingest endpoint only ever calls `insertMailCandidate` (one table, nothing
 * else); every other function here is an owner decision behind a session, checked against the
 * candidate's `version` (compare-and-set in the UPDATE's WHERE, like reviews).
 */

const COLUMNS = `
  m.id, m.source, m.message_id as "messageId", m.thread_id as "threadId", m.received_at as "receivedAt",
  m.from_name as "fromName", m.from_address as "fromAddress", m.subject, m.snippet, m.extracted, m.evidence,
  m.confidence, m.status, m.review_id as "reviewId", r.product_name as "reviewName",
  m.created_at as "createdAt", m.decided_at as "decidedAt", m.version`;
const FROM = `from mail_candidates m left join reviews r on r.id = m.review_id`;

/** Statuses the owner can still act on (a duplicate may still become its own review). */
const OPEN: MailStatus[] = ['pending', 'duplicate'];

/** Serializes ingest and decisions on one thread, so "thread already has a review" is never missed. */
function lockThread(tx: Queryable, source: string, threadId: string) {
  return tx.query(`select pg_advisory_xact_lock(hashtextextended('mail-thread:' || $1 || ':' || $2, 0))`, [source, threadId]);
}

/** The review of the thread's latest accepted candidate, if any. Call under the thread lock. */
async function threadReviewId(tx: Queryable, source: string, threadId: string): Promise<number | null> {
  const { rows } = await tx.query<{ reviewId: number }>(
    `select review_id as "reviewId" from mail_candidates
      where source = $1 and thread_id = $2 and status = 'accepted'
      order by decided_at desc, id desc limit 1`,
    [source, threadId],
  );
  return rows[0]?.reviewId ?? null;
}

/** Thread first (like ingest and every decision), so decisions in one thread queue instead of deadlocking. */
async function lockCandidateThread(tx: Queryable, id: number): Promise<{ source: string; threadId: string }> {
  // source and thread_id never change, so reading them before the lock is safe
  const { rows } = await tx.query<{ source: string; threadId: string }>(
    'select source, thread_id as "threadId" from mail_candidates where id = $1',
    [id],
  );
  if (!rows[0]) throw new NotFoundError('mail candidate');
  await lockThread(tx, rows[0].source, rows[0].threadId);
  return rows[0];
}

// ---------------------------------------------------------------- ingest

export type IngestOutcome = { created: true; id: number; status: 'pending' | 'duplicate' } | { created: false; id: number };

/**
 * Store one candidate. Idempotent on (source, message_id): a re-sent message changes nothing. A new
 * message in a thread whose earlier mail was already accepted is stored as `duplicate`, linked to that
 * review, instead of asking the owner again.
 */
export async function insertMailCandidate(db: Database, input: MailCandidateInput): Promise<IngestOutcome> {
  return withTransaction(db, async (tx) => {
    await lockThread(tx, input.source, input.thread_id);
    const existing = await tx.query<{ id: number }>(
      'select id from mail_candidates where source = $1 and message_id = $2',
      [input.source, input.message_id],
    );
    if (existing.rows[0]) return { created: false as const, id: existing.rows[0].id };

    const reviewId = await threadReviewId(tx, input.source, input.thread_id);

    const { rows } = await tx.query<{ id: number; status: 'pending' | 'duplicate' }>(
      `insert into mail_candidates (source, message_id, thread_id, received_at, from_name, from_address, subject,
                                    snippet, extracted, evidence, confidence, status, review_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (source, message_id) do nothing
       returning id, status`,
      [
        input.source,
        input.message_id,
        input.thread_id,
        input.received_at,
        input.from_name,
        input.from_address,
        input.subject,
        input.snippet,
        JSON.stringify(input.extracted),
        JSON.stringify(input.evidence),
        input.confidence,
        reviewId === null ? 'pending' : 'duplicate',
        reviewId,
      ],
    );
    if (!rows[0]) {
      // lost a race with a concurrent identical POST (other thread lock); still idempotent
      const again = await tx.query<{ id: number }>('select id from mail_candidates where source = $1 and message_id = $2', [
        input.source,
        input.message_id,
      ]);
      return { created: false as const, id: again.rows[0]!.id };
    }
    return { created: true as const, id: rows[0].id, status: rows[0].status };
  });
}

// ---------------------------------------------------------------- reads

export async function countPendingMail(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from mail_candidates where status = 'pending'`);
  return rows[0]?.n ?? 0;
}

export interface MailInbox {
  /** pending + duplicate, newest mail first; at most MAIL_INBOX_PAGE */
  open: MailCandidate[];
  /** there are older open candidates than the last one in `open` (the next page starts after it) */
  hasMore: boolean;
  /** dismissed in the last 7 days (still undoable), most recent decision first; first page only */
  dismissed: MailCandidate[];
}

/**
 * One page of the inbox. Without `beforeId` the newest page; with it, the open candidates older than
 * that candidate in (received_at, id) order. The cursor row's own values are compared in SQL, so
 * timestamps finer than a JS Date never skip or repeat a row. An unknown id is an empty page.
 */
export async function listMailInbox(db: Queryable, { beforeId = null, now = new Date() }: { beforeId?: number | null; now?: Date } = {}): Promise<MailInbox> {
  const [open, dismissed] = await Promise.all([
    db.query<MailCandidate>(
      `select ${COLUMNS} ${FROM}
        where m.status = any($1::text[])
          and ($2::bigint is null or (m.received_at, m.id) < (select c.received_at, c.id from mail_candidates c where c.id = $2))
        order by m.received_at desc, m.id desc limit $3`,
      [OPEN, beforeId, MAIL_INBOX_PAGE + 1],
    ),
    beforeId !== null
      ? null
      : db.query<MailCandidate>(
          `select ${COLUMNS} ${FROM}
            where m.status = 'dismissed' and m.decided_at > $1::timestamptz - make_interval(days => $2)
            order by m.decided_at desc, m.id desc limit 50`,
          [now, MAIL_UNDO_DAYS],
        ),
  ]);
  return {
    open: open.rows.slice(0, MAIL_INBOX_PAGE),
    hasMore: open.rows.length > MAIL_INBOX_PAGE,
    dismissed: dismissed?.rows ?? [],
  };
}

export async function getMailCandidate(db: Queryable, id: number): Promise<MailCandidate | undefined> {
  const { rows } = await db.query<MailCandidate>(`select ${COLUMNS} ${FROM} where m.id = $1`, [id]);
  return rows[0];
}

// ---------------------------------------------------------------- decisions

export type DecisionOutcome<T = null> = { ok: true; data: T } | { ok: false; error: 'stale' | 'expired' };
const stale = { ok: false as const, error: 'stale' as const };

/**
 * Lock the candidate's thread, then the candidate, and check it is the version the owner saw and still
 * open. Always thread first (like ingest): two decisions in one thread then queue instead of deadlocking
 * (accepting one also updates the thread's other pending rows).
 */
async function lockOpenCandidate(tx: Queryable, id: number, expectedVersion: number): Promise<MailCandidate | 'stale'> {
  await lockCandidateThread(tx, id);
  const { rows } = await tx.query<MailCandidate>(`select ${COLUMNS} ${FROM} where m.id = $1 for update of m`, [id]);
  const candidate = rows[0];
  if (!candidate) throw new NotFoundError('mail candidate');
  if (candidate.version !== expectedVersion || !OPEN.includes(candidate.status)) return 'stale';
  return candidate;
}

/** Mark the candidate accepted for `reviewId`; other still-pending mail of the same thread now points at it too. */
async function markAccepted(tx: Queryable, candidate: MailCandidate, reviewId: number): Promise<boolean> {
  const { rowCount } = await tx.query(
    `update mail_candidates set status = 'accepted', review_id = $2, decided_at = now()
      where id = $1 and version = $3 and status = any($4::text[])`,
    [candidate.id, reviewId, candidate.version, OPEN],
  );
  if (rowCount !== 1) return false;
  await tx.query(
    `update mail_candidates set status = 'duplicate', review_id = $3
      where source = $1 and thread_id = $2 and status = 'pending'`,
    [candidate.source, candidate.threadId, reviewId],
  );
  return true;
}

/**
 * The 받음 intake stage for reviews created from mail: the default stage when it is a to-do stage,
 * otherwise the first to-do stage on the board.
 */
export async function mailIntakeStage(db: Queryable): Promise<Stage> {
  const stages = await listStages(db);
  const stage = stages.find((s) => s.isDefault && s.categoryKey === 'todo') ?? stages.find((s) => s.categoryKey === 'todo');
  if (!stage) throw new Error('no to-do review stage configured');
  return stage;
}

/**
 * 리뷰로 등록 — ONE transaction: (optional) new brand, the review in the intake stage with the dates the
 * owner confirmed, and the candidate marked accepted with the review id. Any failure rolls all of it
 * back; a candidate changed or decided elsewhere since the inbox loaded is refused as `stale`.
 */
export async function acceptMailCandidate(
  db: Database,
  id: number,
  expectedVersion: number,
  input: MailAcceptInput,
): Promise<DecisionOutcome<{ reviewId: number; brandCreated: boolean }>> {
  return withTransaction(db, async (tx) => {
    const candidate = await lockOpenCandidate(tx, id, expectedVersion);
    if (candidate === 'stale') return stale;

    let brandId = input.brandId;
    let brandCreated = false;
    if (input.newBrandName !== null) {
      // the brand may have been added since the form opened: reuse it (names are unique case-insensitively)
      const found = await tx.query<{ id: number }>(
        'select id from brands where archived_at is null and lower(name) = lower($1)',
        [input.newBrandName],
      );
      if (found.rows[0]) {
        brandId = found.rows[0].id;
      } else {
        const created = await tx.query<{ id: number }>(`insert into brands (name) values ($1) returning id`, [input.newBrandName]);
        brandId = created.rows[0]!.id;
        brandCreated = true;
      }
    }

    const stage = await mailIntakeStage(tx);
    const reviewId = await createReviewInTx(
      tx,
      {
        productName: input.productName,
        templateId: input.templateId,
        stageId: stage.id,
        brandId,
        sourceType: input.sourceType,
        anchorField: null,
        anchorDate: null,
      },
      {
        dates: {
          receivedOn: null,
          shootOn: null,
          writeDueOn: input.writeDueOn,
          publishPlannedOn: input.publishPlannedOn,
          embargoUntil: input.embargoUntil,
        },
        notesMd: buildMailNotes(candidate, input.memo),
      },
    );
    if (!(await markAccepted(tx, candidate, reviewId))) throw new Error('mail candidate changed inside its own lock');
    return { ok: true as const, data: { reviewId, brandCreated } };
  });
}

/** 기존 리뷰에 연결 — the candidate is accepted for an existing (not archived) review. */
export async function linkMailCandidate(db: Database, id: number, expectedVersion: number, reviewId: number): Promise<DecisionOutcome> {
  return withTransaction(db, async (tx) => {
    const candidate = await lockOpenCandidate(tx, id, expectedVersion);
    if (candidate === 'stale') return stale;
    const review = await tx.query('select 1 from reviews where id = $1 and archived_at is null for share', [reviewId]);
    if (review.rowCount !== 1) throw new NotFoundError('review');
    if (!(await markAccepted(tx, candidate, reviewId))) throw new Error('mail candidate changed inside its own lock');
    return { ok: true as const, data: null };
  });
}

/**
 * 무시 — pending or duplicate → dismissed (a duplicate keeps its review link for the undo). Returns the
 * new version, which the toast's 되돌리기 needs.
 */
export async function dismissMailCandidate(db: Queryable, id: number, expectedVersion: number): Promise<DecisionOutcome<{ version: number }>> {
  const { rows } = await db.query<{ version: number }>(
    `update mail_candidates set status = 'dismissed', decided_at = now()
      where id = $1 and version = $2 and status = any($3::text[])
      returning version`,
    [id, expectedVersion, OPEN],
  );
  if (rows[0]) return { ok: true, data: { version: rows[0].version } };
  await assertExists(db, id);
  return stale;
}

/**
 * 되돌리기 — within 7 days of the dismissal, back into the inbox. If the thread has an accepted review by
 * now (accepted while this one was dismissed), it returns as a duplicate linked to that review, exactly
 * as a new mail of that thread would arrive. Otherwise pending, or duplicate of the review it had.
 * Thread lock first, like accept, so an accept running at the same time is either seen here or sees
 * this row back as pending (and turns it into a duplicate itself).
 */
export async function undoDismissMailCandidate(db: Database, id: number, expectedVersion: number, now = new Date()): Promise<DecisionOutcome> {
  return withTransaction(db, async (tx) => {
    const { source, threadId } = await lockCandidateThread(tx, id);
    const accepted = await threadReviewId(tx, source, threadId);
    const { rowCount } = await tx.query(
      `update mail_candidates
          set review_id = coalesce($5::bigint, review_id),
              status = case when coalesce($5::bigint, review_id) is null then 'pending' else 'duplicate' end,
              decided_at = null
        where id = $1 and version = $2 and status = 'dismissed'
          and decided_at > $3::timestamptz - make_interval(days => $4)`,
      [id, expectedVersion, now, MAIL_UNDO_DAYS, accepted],
    );
    if (rowCount === 1) return { ok: true as const, data: null };
    const { rows } = await tx.query<{ version: number; status: MailStatus }>('select version, status from mail_candidates where id = $1', [id]);
    return rows[0]!.version === expectedVersion && rows[0]!.status === 'dismissed' ? { ok: false as const, error: 'expired' as const } : stale;
  });
}

async function assertExists(db: Queryable, id: number) {
  const { rowCount } = await db.query('select 1 from mail_candidates where id = $1', [id]);
  if (rowCount !== 1) throw new NotFoundError('mail candidate');
}
