import { beforeEach, describe, expect, it } from 'vitest';
import { listCalendarChips } from '../../src/server/db/calendar';
import {
  createReview,
  getReview,
  getStageHistory,
  listReviews,
  moveReviewDate,
  moveReviewStage,
  searchReviews,
  setReviewArchived,
  updateReview,
} from '../../src/server/db/reviews';
import { toReviewForm } from '../../src/lib/review-form';
import { reviewCreateSchema, reviewUpdateSchema } from '../../src/lib/validation';
import { pgErrorCode, resetData, stageIdsByName, useAdminPool, useAppPool } from './helpers';

const create = (pool: Parameters<typeof createReview>[0], input: Record<string, unknown>) =>
  createReview(pool, reviewCreateSchema.parse(input));

describe('reviews CRUD', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetData(admin));

  it('creates a review from only a product name (R1.1)', async () => {
    const id = await create(db, { productName: '  테스트 헤드폰  ' });
    const review = await getReview(db, id);
    expect(review).toMatchObject({
      productName: '테스트 헤드폰',
      title: null,
      brandId: null,
      sourceType: null,
      stageName: '입고',
      categoryKey: 'todo',
      priority: 'normal',
      channels: [],
      shootOn: null,
      writeDueOn: null,
      publishPlannedOn: null,
      archivedAt: null,
    });
    const history = await getStageHistory(db, id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStageName: null, toStageName: '입고' });
  });

  it('updates every editable field', async () => {
    const stages = await stageIdsByName(db);
    const id = await create(db, { productName: '키보드' });
    const brand = await db.query<{ id: number }>(`insert into brands (name) values ('Demo') returning id`);
    const result = await updateReview(
      db,
      id,
      reviewUpdateSchema.parse({
        productName: '키보드 v2',
        title: '한 달 사용기',
        brandId: brand.rows[0]!.id,
        sourceType: 'gift',
        stageId: stages['촬영'],
        priority: 'high',
        channels: ['youtube', 'blog'],
        receivedOn: '2026-10-01',
        shootOn: '2026-10-05',
        shootStartTime: '14:00',
        shootEndTime: '15:30',
        writeDueOn: '2026-10-09',
        publishPlannedOn: '2026-10-12',
        embargoUntil: '2026-10-11',
        publishedAtLocal: '',
        publishedUrl: 'https://example.com/v',
        notesMd: '# 메모',
      }),
    );
    expect(result).toMatchObject({ ok: true });
    const review = await getReview(db, id);
    expect(review).toMatchObject({
      productName: '키보드 v2',
      title: '한 달 사용기',
      brandName: 'Demo',
      sourceType: 'gift',
      stageName: '촬영',
      priority: 'high',
      channels: ['youtube', 'blog'],
      receivedOn: '2026-10-01',
      shootOn: '2026-10-05',
      // 14:00 KST = 05:00 UTC
      shootStartsAt: '2026-10-05T05:00:00.000Z',
      shootEndsAt: '2026-10-05T06:30:00.000Z',
      writeDueOn: '2026-10-09',
      publishPlannedOn: '2026-10-12',
      embargoUntil: '2026-10-11',
      publishedUrl: 'https://example.com/v',
      notesMd: '# 메모',
    });
    const history = await getStageHistory(db, id);
    expect(history.map((h) => h.toStageName)).toEqual(['촬영', '입고']);
  });

  it('lists with filters: category matches every stage in it (R1.2)', async () => {
    const stages = await stageIdsByName(db);
    await create(db, { productName: 'A', stageId: stages['촬영'] });
    await create(db, { productName: 'B', stageId: stages['검수'] });
    await create(db, { productName: 'C', stageId: stages['입고'] });
    await create(db, { productName: 'D', stageId: stages['발행'] });

    const inProgress = await listReviews(db, { category: 'in_progress', sort: 'product' });
    expect(inProgress.map((r) => r.productName)).toEqual(['A', 'B']);

    const byStage = await listReviews(db, { stageId: stages['입고'] });
    expect(byStage.map((r) => r.productName)).toEqual(['C']);

    const sortedByStage = await listReviews(db, { sort: 'stage', dir: 'desc' });
    expect(sortedByStage.map((r) => r.productName)).toEqual(['D', 'B', 'A', 'C']);
  });

  it('filters by brand, date range and search text', async () => {
    const brand = await db.query<{ id: number }>(`insert into brands (name) values ('Kestrel Labs') returning id`);
    await create(db, { productName: '마우스', brandId: brand.rows[0]!.id, anchorField: 'shoot', anchorDate: '2026-10-10' });
    await create(db, { productName: '마이크', anchorField: 'shoot', anchorDate: '2026-10-20' });
    await create(db, { productName: '100% 키보드' });

    expect((await listReviews(db, { brandId: brand.rows[0]!.id })).map((r) => r.productName)).toEqual(['마우스']);
    expect(
      (await listReviews(db, { dateField: 'shoot', from: '2026-10-15', to: '2026-10-31' })).map((r) => r.productName),
    ).toEqual(['마이크']);
    expect((await searchReviews(db, 'kestrel')).map((r) => r.productName)).toEqual(['마우스']);
    // LIKE wildcards in the query are literal
    expect((await searchReviews(db, '100%')).map((r) => r.productName)).toEqual(['100% 키보드']);
    expect(await searchReviews(db, '%')).toHaveLength(1);
  });

  it('archive hides a review everywhere and restore brings it back', async () => {
    const id = await create(db, { productName: '보관할 리뷰', anchorField: 'publish_planned', anchorDate: '2026-10-15' });
    expect(await setReviewArchived(db, id, true)).toBe(true);

    expect(await listReviews(db)).toEqual([]);
    expect(await searchReviews(db, '보관')).toEqual([]);
    expect(
      await listCalendarChips(db, { from: '2026-10-01', to: '2026-11-01', fields: ['publish_planned'] }, '2026-10-01'),
    ).toEqual([]);
    expect((await listReviews(db, { archived: true })).map((r) => r.id)).toEqual([id]);
    // the row itself still exists (soft delete)
    expect((await getReview(db, id))?.archivedAt).not.toBeNull();

    await setReviewArchived(db, id, false);
    expect((await listReviews(db)).map((r) => r.id)).toEqual([id]);
  });

  it('database CHECKs reject empty names and out-of-order dates even without zod', async () => {
    const stages = await stageIdsByName(db);
    await expect(
      db.query(`insert into reviews (product_name, stage_id) values ('   ', $1)`, [stages['입고']]),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
    await expect(
      db.query(
        `insert into reviews (product_name, stage_id, shoot_on, write_due_on) values ('x', $1, '2026-10-10', '2026-10-09')`,
        [stages['입고']],
      ),
    ).rejects.toMatchObject({ constraint: 'reviews_shoot_before_write_due' });
    await expect(
      db.query(
        `insert into reviews (product_name, stage_id, shoot_on, shoot_starts_at)
         values ('x', $1, '2026-10-10', '2026-10-10T16:00:00Z')`, // = 10-11 01:00 KST
        [stages['입고']],
      ),
    ).rejects.toMatchObject({ constraint: 'reviews_shoot_time_on_day' });
  });

  it('a review stage must be a review stage (composite FK)', async () => {
    const task = await db.query<{ id: number }>(
      `insert into workflow_stages (entity_type, category_key, name, sort) values ('task', 'todo', '할 일', 1) returning id`,
    );
    await expect(
      db.query(`insert into reviews (product_name, stage_id) values ('x', $1)`, [task.rows[0]!.id]),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === '23503');
    await db.query('delete from workflow_stages where id = $1', [task.rows[0]!.id]);
  });
});

describe('review save: optimistic concurrency (updated_at check)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetData(admin));

  /** What the peek / detail form does: load, change, send the whole form with the loaded updatedAt. */
  async function saveLoaded(id: number, change: Record<string, unknown>, expected?: string) {
    const loaded = (await getReview(db, id))!;
    const input = reviewUpdateSchema.parse({ ...toReviewForm(loaded), ...change });
    return updateReview(db, id, input, new Date(), expected ?? loaded.updatedAt);
  }

  it('a save with the updatedAt it was loaded with goes through and returns the new updatedAt', async () => {
    const id = await create(db, { productName: '마우스', anchorField: 'shoot', anchorDate: '2026-10-20' });
    const before = (await getReview(db, id))!.updatedAt;
    const result = await saveLoaded(id, { publishPlannedOn: '2026-10-28' });
    expect(result.ok).toBe(true);
    const after = (await getReview(db, id))!;
    expect(after.publishPlannedOn).toBe('2026-10-28');
    expect(result.ok && result.updatedAt).toBe(after.updatedAt);
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before));
    // the returned value is good for the next save from the same form (peek stays open after saving)
    expect((await saveLoaded(id, { title: '두 번째 저장' }, result.ok ? result.updatedAt : undefined)).ok).toBe(true);
  });

  it('refuses a stale save after a calendar drag elsewhere and writes nothing', async () => {
    const id = await create(db, { productName: '헤드폰', anchorField: 'shoot', anchorDate: '2026-10-20' });
    const loaded = (await getReview(db, id))!;
    await new Promise((r) => setTimeout(r, 5)); // a different millisecond for the other write
    await moveReviewDate(db, { reviewId: id, field: 'shoot', date: '2026-10-21', startTime: null, endTime: null });
    const input = reviewUpdateSchema.parse({ ...toReviewForm(loaded), productName: '헤드폰 (덮어쓰기)' });
    expect(await updateReview(db, id, input, new Date(), loaded.updatedAt)).toEqual({ ok: false, error: 'stale' });
    const now = (await getReview(db, id))!;
    expect([now.productName, now.shootOn]).toEqual(['헤드폰', '2026-10-21']);
  });

  it('refuses a stale save after a board stage move or another tab’s save', async () => {
    const stages = await stageIdsByName(db);
    const id = await create(db, { productName: '키보드' });
    const loaded = (await getReview(db, id))!;
    await new Promise((r) => setTimeout(r, 5));
    await moveReviewStage(db, id, stages['촬영']!);
    const input = reviewUpdateSchema.parse({ ...toReviewForm(loaded), title: '탭 A' });
    expect(await updateReview(db, id, input, new Date(), loaded.updatedAt)).toEqual({ ok: false, error: 'stale' });

    const fresh = (await getReview(db, id))!;
    await new Promise((r) => setTimeout(r, 5));
    expect((await saveLoaded(id, { title: '탭 B' })).ok).toBe(true); // the other tab saves first
    const tabA = reviewUpdateSchema.parse({ ...toReviewForm(fresh), title: '탭 A' });
    expect(await updateReview(db, id, tabA, new Date(), fresh.updatedAt)).toEqual({ ok: false, error: 'stale' });
    const row = (await getReview(db, id))!;
    expect([row.title, row.stageName]).toEqual(['탭 B', '촬영']);
  });

  it('checklist toggles do not make an open form stale', async () => {
    const templates = await db.query<{ id: number }>(`select id from templates where source_type = 'loan' limit 1`);
    const id = await create(db, { productName: '마이크', templateId: templates.rows[0]!.id });
    const loaded = (await getReview(db, id))!;
    await db.query(`update review_checklist_items set done_at = now() where review_id = $1`, [id]);
    const input = reviewUpdateSchema.parse({ ...toReviewForm(loaded), priority: 'high' });
    expect((await updateReview(db, id, input, new Date(), loaded.updatedAt)).ok).toBe(true);
  });

  it('without an expected updatedAt the save behaves as before (no check)', async () => {
    const id = await create(db, { productName: '스피커' });
    const loaded = (await getReview(db, id))!;
    await new Promise((r) => setTimeout(r, 5));
    await db.query(`update reviews set title = 'elsewhere' where id = $1`, [id]);
    const input = reviewUpdateSchema.parse({ ...toReviewForm(loaded), title: 'mine' });
    expect((await updateReview(db, id, input)).ok).toBe(true);
    expect((await getReview(db, id))!.title).toBe('mine');
  });

  it('a stale check still runs the DB rules for a fresh save (Korean messages come from the CHECKs)', async () => {
    const id = await create(db, { productName: '카메라', anchorField: 'shoot', anchorDate: '2026-10-20' });
    const loaded = (await getReview(db, id))!;
    // bypass zod (which would catch it first) to prove the DB is the last word on the same path
    const input = { ...reviewUpdateSchema.parse(toReviewForm(loaded)), writeDueOn: '2026-10-19' };
    await expect(updateReview(db, id, input, new Date(), loaded.updatedAt)).rejects.toMatchObject({
      constraint: 'reviews_shoot_before_write_due',
    });
  });
});
