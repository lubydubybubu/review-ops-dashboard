import { beforeEach, describe, expect, it } from 'vitest';
import { reviewCreateSchema } from '../../src/lib/validation';
import {
  createReview,
  getReview,
  getStageHistory,
  moveReviewStage,
  moveReviewStageInTx,
  setReviewArchived,
} from '../../src/server/db/reviews';
import { resetData, stageIdsByName, useAdminPool, useAppPool } from './helpers';

describe('stage moves (R1.3)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  let stages: Record<string, number>;
  let reviewId: number;

  beforeEach(async () => {
    await resetData(admin);
    stages = await stageIdsByName(db);
    reviewId = await createReview(db, reviewCreateSchema.parse({ productName: '보드 이동' }));
  });

  it('changes the stage and writes one history row with from/to and timestamp', async () => {
    const before = Date.now();
    const outcome = await moveReviewStage(db, reviewId, stages['촬영']!);
    expect(outcome).toEqual({ ok: true, moved: true });

    expect((await getReview(db, reviewId))?.stageName).toBe('촬영');
    const history = await getStageHistory(db, reviewId);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ fromStageName: '입고', toStageName: '촬영' });
    expect(Date.parse(history[0]!.changedAt)).toBeGreaterThanOrEqual(before - 5_000);
  });

  it('moving to the same stage is a no-op without history', async () => {
    expect(await moveReviewStage(db, reviewId, stages['입고']!)).toEqual({ ok: true, moved: false });
    expect(await getStageHistory(db, reviewId)).toHaveLength(1);
  });

  it('is atomic: rolling back the transaction discards both the stage and the history row', async () => {
    const client = await db.connect();
    try {
      await client.query('begin');
      await moveReviewStageInTx(client, reviewId, stages['검수']!, new Date());
      // visible inside the transaction …
      const inside = await client.query('select count(*)::int as n from review_stage_history where review_id = $1', [
        reviewId,
      ]);
      expect(inside.rows[0].n).toBe(2);
      await client.query('rollback');
    } finally {
      client.release();
    }
    // … and gone together afterwards
    expect((await getReview(db, reviewId))?.stageName).toBe('입고');
    expect(await getStageHistory(db, reviewId)).toHaveLength(1);
  });

  it('a failed move leaves no trace', async () => {
    const outcome = await moveReviewStage(db, reviewId, 999_999);
    expect(outcome).toEqual({ ok: false, error: 'unknown_stage' });
    expect((await getReview(db, reviewId))?.stageName).toBe('입고');
    expect(await getStageHistory(db, reviewId)).toHaveLength(1);
  });

  it('concurrent moves serialize and each leaves a history row', async () => {
    await Promise.all([
      moveReviewStage(db, reviewId, stages['촬영']!),
      moveReviewStage(db, reviewId, stages['검수']!),
    ]);
    const history = await getStageHistory(db, reviewId);
    expect(history).toHaveLength(3);
    // chain is consistent: each row starts where the previous one ended
    const chronological = [...history].reverse();
    for (let i = 1; i < chronological.length; i++) {
      expect(chronological[i]!.fromStageName).toBe(chronological[i - 1]!.toStageName);
    }
  });

  it('entering 발행 stamps published_at once; 보류 does not', async () => {
    await moveReviewStage(db, reviewId, stages['보류']!);
    expect((await getReview(db, reviewId))?.publishedAt).toBeNull();

    await moveReviewStage(db, reviewId, stages['발행']!, new Date('2026-10-19T03:00:00Z'));
    expect((await getReview(db, reviewId))?.publishedAt).toBe('2026-10-19T03:00:00.000Z');

    await moveReviewStage(db, reviewId, stages['검수']!);
    await moveReviewStage(db, reviewId, stages['발행']!, new Date('2026-10-25T03:00:00Z'));
    expect((await getReview(db, reviewId))?.publishedAt).toBe('2026-10-19T03:00:00.000Z');
  });

  it('archived reviews cannot be moved', async () => {
    await setReviewArchived(db, reviewId, true);
    expect(await moveReviewStage(db, reviewId, stages['촬영']!)).toEqual({ ok: false, error: 'archived' });
  });
});
