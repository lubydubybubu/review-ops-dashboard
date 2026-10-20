import { beforeEach, describe, expect, it } from 'vitest';
import { kstInstant } from '../../src/lib/domain/dates';
import { dateMoveSchema } from '../../src/lib/validation';
import { listCalendarChips } from '../../src/server/db/calendar';
import { moveReviewDate, NotFoundError, setReviewArchived } from '../../src/server/db/reviews';
import { resetData, stageIdsByName, useAdminPool, useAppPool } from './helpers';

/** Full row minus bookkeeping, to prove a drag touched exactly one field. */
async function snapshot(db: ReturnType<typeof useAppPool>, id: number) {
  const { rows } = await db.query('select * from reviews where id = $1', [id]);
  const { updated_at: _updatedAt, ...rest } = rows[0];
  return rest as Record<string, unknown>;
}

describe('calendar (R1.4)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  let reviewId: number;
  let stages: Record<string, number>;

  beforeEach(async () => {
    await resetData(admin);
    stages = await stageIdsByName(db);
    const { rows } = await db.query<{ id: number }>(
      `insert into reviews (product_name, stage_id, received_on, shoot_on, shoot_starts_at, shoot_ends_at,
                            write_due_on, publish_planned_on, embargo_until)
       values ('캘린더 리뷰', $1, '2026-10-02', '2026-10-05', $2, $3, '2026-10-08', '2026-10-10', '2026-10-09')
       returning id`,
      [stages['작성/편집'], kstInstant('2026-10-05', '14:00'), kstInstant('2026-10-05', '16:00')],
    );
    reviewId = rows[0]!.id;
  });

  const range = { from: '2026-10-01', to: '2026-11-01' };

  it('returns chips for the chosen fields only', async () => {
    const publishOnly = await listCalendarChips(db, { ...range, fields: ['publish_planned'] }, '2026-10-01');
    expect(publishOnly.map((c) => [c.field, c.date])).toEqual([['publish_planned', '2026-10-10']]);

    const two = await listCalendarChips(db, { ...range, fields: ['shoot', 'embargo'] }, '2026-10-01');
    expect(two.map((c) => [c.field, c.date])).toEqual([
      ['shoot', '2026-10-05'],
      ['embargo', '2026-10-09'],
    ]);
    expect(two[0]).toMatchObject({ startsAt: '2026-10-05T05:00:00.000Z', endsAt: '2026-10-05T07:00:00.000Z' });

    const all = await listCalendarChips(db, { ...range, fields: ['shoot', 'write_due', 'publish_planned', 'embargo'] }, '2026-10-01');
    expect(all.map((c) => c.field)).toEqual(['shoot', 'write_due', 'embargo', 'publish_planned']);

    expect(await listCalendarChips(db, { ...range, fields: [] }, '2026-10-01')).toEqual([]);
  });

  it('uses a half-open range [from, to)', async () => {
    const chips = await listCalendarChips(db, { from: '2026-10-08', to: '2026-10-10', fields: ['write_due', 'publish_planned'] }, '2026-10-01');
    expect(chips.map((c) => c.date)).toEqual(['2026-10-08']);
  });

  it('flags overdue deadline chips only, using the KST day', async () => {
    const chips = await listCalendarChips(db, { ...range, fields: ['shoot', 'write_due', 'publish_planned', 'embargo'] }, '2026-10-09');
    const overdue = Object.fromEntries(chips.map((c) => [c.field, c.overdue]));
    expect(overdue).toEqual({ shoot: false, write_due: true, embargo: false, publish_planned: false });

    await db.query('update reviews set stage_id = $2 where id = $1', [reviewId, stages['발행']]);
    const done = await listCalendarChips(db, { ...range, fields: ['write_due'] }, '2026-10-09');
    expect(done[0]?.overdue).toBe(false);
  });

  it('dragging the publish chip from the 10th to the 12th changes publish_planned_on only', async () => {
    const before = await snapshot(db, reviewId);
    await moveReviewDate(db, dateMoveSchema.parse({ reviewId, field: 'publish_planned', date: '2026-10-12' }));
    const after = await snapshot(db, reviewId);
    expect(after.publish_planned_on).toBe('2026-10-12');
    expect({ ...after, publish_planned_on: before.publish_planned_on }).toEqual(before);
  });

  it('dragging a timed shoot to another day keeps its time window and touches only shoot columns', async () => {
    const before = await snapshot(db, reviewId);
    await moveReviewDate(db, dateMoveSchema.parse({ reviewId, field: 'shoot', date: '2026-10-07' }));
    const after = await snapshot(db, reviewId);
    expect(after.shoot_on).toBe('2026-10-07');
    expect(after.shoot_starts_at).toBe(kstInstant('2026-10-07', '14:00'));
    expect(after.shoot_ends_at).toBe(kstInstant('2026-10-07', '16:00'));
    const { shoot_on: _a, shoot_starts_at: _b, shoot_ends_at: _c, ...untouched } = after;
    const { shoot_on: _d, shoot_starts_at: _e, shoot_ends_at: _f, ...untouchedBefore } = before;
    expect(untouched).toEqual(untouchedBefore);
  });

  it('dropping a shoot on the week time grid sets a new window', async () => {
    await moveReviewDate(
      db,
      dateMoveSchema.parse({ reviewId, field: 'shoot', date: '2026-10-06', startTime: '09:30', endTime: '12:00' }),
    );
    const after = await snapshot(db, reviewId);
    expect(after.shoot_starts_at).toBe('2026-10-06T00:30:00.000Z');
    expect(after.shoot_ends_at).toBe('2026-10-06T03:00:00.000Z');
  });

  it('a drag that breaks date order is rejected by the database and changes nothing', async () => {
    const before = await snapshot(db, reviewId);
    await expect(
      moveReviewDate(db, dateMoveSchema.parse({ reviewId, field: 'write_due', date: '2026-10-04' })),
    ).rejects.toMatchObject({ constraint: 'reviews_shoot_before_write_due' });
    expect(await snapshot(db, reviewId)).toEqual(before);
  });

  it('archived reviews cannot be dragged', async () => {
    await setReviewArchived(db, reviewId, true);
    await expect(
      moveReviewDate(db, dateMoveSchema.parse({ reviewId, field: 'embargo', date: '2026-10-20' })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
