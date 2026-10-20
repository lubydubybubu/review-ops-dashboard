import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAIL_INBOX_PAGE } from '../../src/lib/mail';
import { mailAcceptSchema } from '../../src/lib/validation';
import {
  acceptMailCandidate,
  countPendingMail,
  dismissMailCandidate,
  getMailCandidate,
  insertMailCandidate,
  linkMailCandidate,
  listMailInbox,
  undoDismissMailCandidate,
} from '../../src/server/db/mail';
import { createReview, getReview, NotFoundError } from '../../src/server/db/reviews';
import { mailCandidateSchema } from '../../src/server/ingest/schema';
import { reviewCreateSchema } from '../../src/lib/validation';
import { candidatePayload, hexId, INJECTION, type CandidatePayload } from '../fixtures/mail';
import { pgErrorCode, resetData, useAdminPool, useAppPool } from './helpers';

const ingest = (db: pg.Pool, payload: CandidatePayload) => insertMailCandidate(db, mailCandidateSchema.parse(payload));
const acceptInput = (raw: Record<string, unknown> = {}) =>
  mailAcceptSchema.parse({
    productName: 'Northwind NX9 무선 헤드폰',
    newBrandName: 'Northwind',
    sourceType: 'loan',
    writeDueOn: '2026-10-30',
    publishPlannedOn: '2026-11-04',
    embargoUntil: '2026-11-03',
    memo: '반납 시 정품 박스 포함\n반납 기한: 2026-11-10',
    ...raw,
  });

async function created(db: pg.Pool, payload: CandidatePayload) {
  const outcome = await ingest(db, payload);
  if (!outcome.created) throw new Error('expected a new candidate');
  return (await getMailCandidate(db, outcome.id))!;
}

const counts = async (db: pg.Pool) => {
  const { rows } = await db.query<{ reviews: number; brands: number }>(
    'select (select count(*)::int from reviews) as reviews, (select count(*)::int from brands) as brands',
  );
  return rows[0]!;
};

describe('mail candidates', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetData(admin));

  it('ingest is idempotent on (source, message_id) and stores only mail_candidates rows', async () => {
    const before = await counts(db);
    const payload = candidatePayload();
    const first = await ingest(db, payload);
    expect(first).toMatchObject({ created: true, status: 'pending' });
    // a re-sent message with different content changes nothing
    const again = await ingest(db, { ...payload, subject: '바뀐 제목', confidence: 0.1 });
    expect(again).toEqual({ created: false, id: first.id });
    // uppercase id is the same message
    const upper = await ingest(db, { ...payload, message_id: payload.message_id.toUpperCase() });
    expect(upper).toEqual({ created: false, id: first.id });
    const row = await getMailCandidate(db, first.id);
    expect(row).toMatchObject({ subject: payload.subject, confidence: 0.92, status: 'pending', reviewId: null, version: 1 });
    expect(row?.extracted).toEqual(payload.extracted);
    expect(row?.evidence).toEqual(payload.evidence);
    const total = await db.query<{ n: number }>('select count(*)::int as n from mail_candidates');
    expect(total.rows[0]!.n).toBe(1);
    expect(await counts(db)).toEqual(before);
    expect(await countPendingMail(db)).toBe(1);
  });

  it('concurrent identical POSTs store one row', async () => {
    const payload = candidatePayload();
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => ingest(db, payload)));
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.id)).size).toBe(1);
  });

  it('accept: ONE transaction creates the brand + review in 받음 (입고) and marks the candidate accepted', async () => {
    const c = await created(db, candidatePayload({ subject: INJECTION.subject, from_name: INJECTION.fromName }));
    const outcome = await acceptMailCandidate(db, c.id, c.version, acceptInput({ templateId: await templateId(db, 'loan') }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data.brandCreated).toBe(true);

    const review = (await getReview(db, outcome.data.reviewId))!;
    expect(review).toMatchObject({
      productName: 'Northwind NX9 무선 헤드폰',
      brandName: 'Northwind',
      sourceType: 'loan',
      stageName: '입고',
      categoryKey: 'todo',
      writeDueOn: '2026-10-30',
      publishPlannedOn: '2026-11-04',
      embargoUntil: '2026-11-03',
      shootOn: null,
      receivedOn: null,
    });
    // template body + checklist kept, mail section appended with the mail text escaped
    expect(review.notesMd).toContain('## 반납');
    expect(review.notesMd).toContain('## 메일에서 온 의뢰');
    expect(review.notesMd).toContain(`<https://mail.google.com/mail/u/0/#all/${c.messageId}>`);
    expect(review.notesMd).toContain('\\<img src\\=x onerror\\=\\"window\\.\\_\\_pwned\\=1\\"\\>');
    expect(review.notesMd).not.toMatch(/(?<!\\)<(img|svg|script|\/h3)/); // only escaped forms
    const checklist = await db.query('select count(*)::int as n from review_checklist_items where review_id = $1', [review.id]);
    expect(checklist.rows[0].n).toBe(4);
    const history = await db.query('select to_stage_id from review_stage_history where review_id = $1', [review.id]);
    expect(history.rows).toHaveLength(1);

    const after = (await getMailCandidate(db, c.id))!;
    expect(after).toMatchObject({ status: 'accepted', reviewId: review.id, reviewName: review.productName, version: c.version + 1 });
    expect(after.decidedAt).not.toBeNull();
    expect(await countPendingMail(db)).toBe(0);
    expect((await listMailInbox(db)).open).toEqual([]);
  });

  it('accept reuses an existing brand matched case-insensitively', async () => {
    const brand = await db.query<{ id: number }>(`insert into brands (name) values ('Northwind') returning id`);
    const c = await created(db, candidatePayload());
    const outcome = await acceptMailCandidate(db, c.id, c.version, acceptInput({ newBrandName: '  northWIND ' }));
    expect(outcome.ok && outcome.data.brandCreated).toBe(false);
    if (!outcome.ok) return;
    expect((await getReview(db, outcome.data.reviewId))!.brandId).toBe(brand.rows[0]!.id);
    expect((await counts(db)).brands).toBe(1);
  });

  it('accept failure rolls back review, brand and candidate together (error before and after the review insert)', async () => {
    const c = await created(db, candidatePayload());
    // 1) fails after the brand insert, before the review: unknown template
    await expect(acceptMailCandidate(db, c.id, c.version, acceptInput({ templateId: 999_999 }))).rejects.toBeInstanceOf(NotFoundError);
    expect(await counts(db)).toEqual({ reviews: 0, brands: 0 });
    expect(await getMailCandidate(db, c.id)).toMatchObject({ status: 'pending', reviewId: null, version: c.version });

    // 2) fails after the review insert, on the candidate update
    await admin.query(`
      create function fail_mail_update() returns trigger language plpgsql as $$
      begin raise exception 'injected failure'; end; $$;
      create trigger fail_mail_update before update on mail_candidates for each row execute function fail_mail_update();`);
    try {
      await expect(acceptMailCandidate(db, c.id, c.version, acceptInput())).rejects.toThrow(/injected failure/);
    } finally {
      await admin.query('drop trigger fail_mail_update on mail_candidates; drop function fail_mail_update();');
    }
    expect(await counts(db)).toEqual({ reviews: 0, brands: 0 });
    expect(await getMailCandidate(db, c.id)).toMatchObject({ status: 'pending', reviewId: null, version: c.version });

    // and it still works afterwards
    expect((await acceptMailCandidate(db, c.id, c.version, acceptInput())).ok).toBe(true);
    expect(await counts(db)).toEqual({ reviews: 1, brands: 1 });
  });

  it('thread re-delivery: new mail in an accepted thread is a duplicate linked to that review; pending siblings follow on accept', async () => {
    const thread = hexId();
    const first = await created(db, candidatePayload({ message_id: hexId(), thread_id: thread }));
    const sibling = await created(db, candidatePayload({ message_id: hexId(), thread_id: thread, subject: 'Re: 일정 문의' }));
    const outcome = await acceptMailCandidate(db, first.id, first.version, acceptInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await getMailCandidate(db, sibling.id)).toMatchObject({ status: 'duplicate', reviewId: outcome.data.reviewId });

    const later = await ingest(db, candidatePayload({ message_id: hexId(), thread_id: thread, subject: 'Re: 촬영 일정 확정' }));
    expect(later).toMatchObject({ created: true, status: 'duplicate' });
    const row = (await getMailCandidate(db, later.id))!;
    expect(row).toMatchObject({ status: 'duplicate', reviewId: outcome.data.reviewId, reviewName: 'Northwind NX9 무선 헤드폰', decidedAt: null });
    // shown in the inbox (같은 스레드 새 메일) but not counted as pending
    expect((await listMailInbox(db)).open.map((m) => m.id)).toEqual([later.id, sibling.id]);
    expect(await countPendingMail(db)).toBe(0);
    // another thread is unaffected
    expect(await ingest(db, candidatePayload())).toMatchObject({ created: true, status: 'pending' });
  });

  it('two accepts in one thread at once: no deadlock, one review, the other refused as stale', async () => {
    const thread = hexId();
    const a = await created(db, candidatePayload({ message_id: hexId(), thread_id: thread }));
    const b = await created(db, candidatePayload({ message_id: hexId(), thread_id: thread }));
    const [ra, rb] = await Promise.all([
      acceptMailCandidate(db, a.id, a.version, acceptInput({ newBrandName: null })),
      acceptMailCandidate(db, b.id, b.version, acceptInput({ newBrandName: null })),
    ]);
    expect([ra.ok, rb.ok].sort()).toEqual([false, true]);
    expect([ra, rb].find((r) => !r.ok)).toEqual({ ok: false, error: 'stale' });
    expect((await counts(db)).reviews).toBe(1);
  });

  it('link to an existing review; archived reviews cannot be linked', async () => {
    const reviewId = await createReview(db, reviewCreateSchema.parse({ productName: '기존 리뷰' }));
    const c = await created(db, candidatePayload());
    expect(await linkMailCandidate(db, c.id, c.version, reviewId)).toEqual({ ok: true, data: null });
    expect(await getMailCandidate(db, c.id)).toMatchObject({ status: 'accepted', reviewId, reviewName: '기존 리뷰' });
    expect((await counts(db)).reviews).toBe(1);

    const d = await created(db, candidatePayload());
    await db.query('update reviews set archived_at = now() where id = $1', [reviewId]);
    await expect(linkMailCandidate(db, d.id, d.version, reviewId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await getMailCandidate(db, d.id)).toMatchObject({ status: 'pending', version: d.version });
  });

  it('dismiss and undo (7 days): pending ↔ dismissed, a duplicate returns to duplicate, expired undo is refused', async () => {
    const c = await created(db, candidatePayload());
    const dismissed = await dismissMailCandidate(db, c.id, c.version);
    expect(dismissed).toEqual({ ok: true, data: { version: c.version + 1 } });
    expect(await countPendingMail(db)).toBe(0);
    const inbox = await listMailInbox(db);
    expect([inbox.open.length, inbox.dismissed.map((m) => m.id)]).toEqual([0, [c.id]]);

    expect(await undoDismissMailCandidate(db, c.id, c.version + 1)).toEqual({ ok: true, data: null });
    expect(await getMailCandidate(db, c.id)).toMatchObject({ status: 'pending', decidedAt: null, version: c.version + 2 });
    expect(await countPendingMail(db)).toBe(1);

    // duplicate → dismissed → duplicate (keeps its review link)
    const thread = hexId();
    const first = await created(db, candidatePayload({ message_id: hexId(), thread_id: thread }));
    const accepted = await acceptMailCandidate(db, first.id, first.version, acceptInput());
    const dup = (await getMailCandidate(db, (await ingest(db, candidatePayload({ message_id: hexId(), thread_id: thread }))).id))!;
    expect(dup.status).toBe('duplicate');
    await dismissMailCandidate(db, dup.id, dup.version);
    await undoDismissMailCandidate(db, dup.id, dup.version + 1);
    expect(await getMailCandidate(db, dup.id)).toMatchObject({ status: 'duplicate', reviewId: accepted.ok ? accepted.data.reviewId : -1 });

    // older than 7 days: not listed, not undoable
    const old = await created(db, candidatePayload());
    await dismissMailCandidate(db, old.id, old.version);
    await admin.query(`update mail_candidates set decided_at = now() - interval '7 days 1 minute' where id = $1`, [old.id]);
    const v = (await getMailCandidate(db, old.id))!.version;
    expect((await listMailInbox(db)).dismissed.map((m) => m.id)).not.toContain(old.id);
    expect(await undoDismissMailCandidate(db, old.id, v)).toEqual({ ok: false, error: 'expired' });
    expect(await getMailCandidate(db, old.id)).toMatchObject({ status: 'dismissed', version: v });
  });

  it('undo in a thread accepted meanwhile comes back as a duplicate linked to that review (not pending)', async () => {
    const thread = hexId();
    const a = await created(db, candidatePayload({ message_id: hexId(), thread_id: thread }));
    const b = await created(db, candidatePayload({ message_id: hexId(), thread_id: thread }));
    const dismissed = await dismissMailCandidate(db, b.id, b.version);
    if (!dismissed.ok) throw new Error('dismiss failed');
    const accepted = await acceptMailCandidate(db, a.id, a.version, acceptInput());
    if (!accepted.ok) throw new Error('accept failed');
    // the accept left the dismissed sibling alone
    expect(await getMailCandidate(db, b.id)).toMatchObject({ status: 'dismissed', reviewId: null });

    expect(await undoDismissMailCandidate(db, b.id, dismissed.data.version)).toEqual({ ok: true, data: null });
    expect(await getMailCandidate(db, b.id)).toMatchObject({ status: 'duplicate', reviewId: accepted.data.reviewId, decidedAt: null });
    expect(await countPendingMail(db)).toBe(0);
  });

  it('undo racing an accept in the same thread: the restored sibling always ends up a duplicate of the new review', async () => {
    for (let round = 0; round < 5; round++) {
      const thread = hexId();
      const a = await created(db, candidatePayload({ message_id: hexId(), thread_id: thread }));
      const b = await created(db, candidatePayload({ message_id: hexId(), thread_id: thread }));
      const dismissed = await dismissMailCandidate(db, b.id, b.version);
      if (!dismissed.ok) throw new Error('dismiss failed');
      const [accepted, undone] = await Promise.all([
        acceptMailCandidate(db, a.id, a.version, acceptInput({ newBrandName: null })),
        undoDismissMailCandidate(db, b.id, dismissed.data.version),
      ]);
      expect([accepted.ok, undone.ok]).toEqual([true, true]);
      if (!accepted.ok) return;
      expect(await getMailCandidate(db, b.id)).toMatchObject({ status: 'duplicate', reviewId: accepted.data.reviewId });
    }
  });

  it('inbox pages: newest MAIL_INBOX_PAGE first, then older pages by cursor, no overlap, still bounded', async () => {
    const template = mailCandidateSchema.parse(candidatePayload());
    // 205 open rows, one second apart (newest = highest g)
    await admin.query(
      `insert into mail_candidates (source, message_id, thread_id, received_at, from_address, subject, extracted, confidence)
       select 'gmail', lpad(to_hex(g), 16, '0'), lpad(to_hex(g), 16, '0'), timestamptz '2026-10-01T00:00:00Z' + make_interval(secs => g),
              'synthetic@example.test', 'page probe', $1::jsonb, 0.5
         from generate_series(1, $2::int) g`,
      [JSON.stringify(template.extracted), MAIL_INBOX_PAGE + 5],
    );
    const first = await listMailInbox(db);
    expect(first.open).toHaveLength(MAIL_INBOX_PAGE);
    expect(first.hasMore).toBe(true);
    expect(first.open[0]!.messageId).toBe((MAIL_INBOX_PAGE + 5).toString(16).padStart(16, '0'));
    const last = first.open.at(-1)!;
    const older = await listMailInbox(db, { beforeId: last.id });
    expect(older.open.map((m) => m.messageId)).toEqual(['5', '4', '3', '2', '1'].map((g) => g.padStart(16, '0')));
    expect(older.hasMore).toBe(false);
    expect(new Set([...first.open, ...older.open].map((m) => m.id)).size).toBe(MAIL_INBOX_PAGE + 5);
    // same received_at (microseconds the JS side cannot hold): the cursor row's own value splits them by id
    await admin.query(`update mail_candidates set received_at = timestamptz '2026-10-01T00:00:00.123456Z' where subject = 'page probe'`);
    const tied = await listMailInbox(db);
    const tail = tied.open.at(-1)!;
    const rest = await listMailInbox(db, { beforeId: tail.id });
    expect(rest.open).toHaveLength(5);
    expect(rest.open.every((m) => m.id < tail.id)).toBe(true);
    // the dismissed list belongs to the first page only; an unknown cursor is an empty page, not an error
    expect(rest.dismissed).toEqual([]);
    expect(await listMailInbox(db, { beforeId: 999_999_999 })).toMatchObject({ open: [], hasMore: false });
  });

  it('stale decisions are refused and write nothing', async () => {
    const c = await created(db, candidatePayload());
    // changed elsewhere (e.g. another tab dismissed and restored it): version moved on
    await dismissMailCandidate(db, c.id, c.version);
    await undoDismissMailCandidate(db, c.id, c.version + 1);
    const before = await counts(db);
    expect(await acceptMailCandidate(db, c.id, c.version, acceptInput())).toEqual({ ok: false, error: 'stale' });
    expect(await dismissMailCandidate(db, c.id, c.version)).toEqual({ ok: false, error: 'stale' });
    expect(await undoDismissMailCandidate(db, c.id, c.version)).toEqual({ ok: false, error: 'stale' });
    expect(await counts(db)).toEqual(before);

    // already decided: a second accept / link / dismiss with the current version is stale too
    const current = (await getMailCandidate(db, c.id))!;
    expect((await acceptMailCandidate(db, c.id, current.version, acceptInput())).ok).toBe(true);
    const done = (await getMailCandidate(db, c.id))!;
    const reviewId = done.reviewId!;
    expect(await acceptMailCandidate(db, c.id, done.version, acceptInput())).toEqual({ ok: false, error: 'stale' });
    expect(await linkMailCandidate(db, c.id, done.version, reviewId)).toEqual({ ok: false, error: 'stale' });
    expect(await dismissMailCandidate(db, c.id, done.version)).toEqual({ ok: false, error: 'stale' });
    expect((await counts(db)).reviews).toBe(1);
    await expect(dismissMailCandidate(db, 999_999, 1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('the table enforces the status shape and caps; the runtime role is still DML-only', async () => {
    const c = await created(db, candidatePayload());
    await expect(db.query(`update mail_candidates set status = 'accepted' where id = $1`, [c.id])).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '23514',
    );
    await expect(db.query(`update mail_candidates set snippet = repeat('x', 1001) where id = $1`, [c.id])).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '23514',
    );
    await expect(db.query(`update mail_candidates set message_id = 'ABC-not-hex' where id = $1`, [c.id])).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '23514',
    );
    // a review with a candidate pointing at it cannot be hard-deleted (the app archives instead)
    const accepted = await acceptMailCandidate(db, c.id, c.version, acceptInput());
    if (!accepted.ok) throw new Error('accept failed');
    await expect(db.query('delete from reviews where id = $1', [accepted.data.reviewId])).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '23503',
    );

    for (const ddl of [
      'alter table mail_candidates add column html text',
      'drop table mail_candidates',
      'truncate mail_candidates',
      'drop trigger mail_candidates_bump_version on mail_candidates',
      'create index should_fail on mail_candidates (subject)',
    ]) {
      await expect(db.query(ddl)).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
    }
    const owner = await db.query<{ mine: boolean }>(
      `select tableowner = current_user as mine from pg_tables where tablename = 'mail_candidates'`,
    );
    expect(owner.rows[0]!.mine).toBe(false);
    const privs = await db.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where table_name = 'mail_candidates' and grantee = current_user order by 1`,
    );
    expect(privs.rows.map((r) => r.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });
});

async function templateId(db: pg.Pool, sourceType: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('select id from templates where source_type = $1 order by sort limit 1', [sourceType]);
  return rows[0]!.id;
}
