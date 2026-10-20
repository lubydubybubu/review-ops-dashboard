import { describe, expect, it } from 'vitest';
import type { Stage } from '../../src/lib/domain/review';
import { planStageMove } from '../../src/lib/domain/stage-move';

const stage = (id: number, over: Partial<Stage> = {}): Stage => ({
  id,
  name: `s${id}`,
  color: '#000000',
  categoryKey: 'in_progress',
  sort: id,
  isDefault: false,
  isOnHold: false,
  archivedAt: null,
  ...over,
});

const now = new Date('2026-10-19T03:00:00Z');
const review = { stageId: 1, publishedAt: null, archivedAt: null };

describe('stage move logic', () => {
  it('moves between stages without touching published_at', () => {
    expect(planStageMove(review, stage(2), now)).toEqual({
      ok: true,
      plan: { kind: 'move', toStageId: 2, publishedAt: null },
    });
  });

  it('same stage is a no-op (no history row)', () => {
    expect(planStageMove(review, stage(1), now)).toEqual({ ok: true, plan: { kind: 'noop' } });
  });

  it('entering a published stage stamps published_at', () => {
    expect(planStageMove(review, stage(6, { categoryKey: 'done' }), now)).toEqual({
      ok: true,
      plan: { kind: 'move', toStageId: 6, publishedAt: '2026-10-19T03:00:00.000Z' },
    });
  });

  it('keeps an existing published_at', () => {
    const published = { ...review, publishedAt: '2026-10-01T00:00:00.000Z' };
    expect(planStageMove(published, stage(6, { categoryKey: 'done' }), now)).toMatchObject({
      plan: { publishedAt: null },
    });
  });

  it('보류 is in 완료 but is not publishing', () => {
    expect(planStageMove(review, stage(7, { categoryKey: 'done', isOnHold: true }), now)).toMatchObject({
      plan: { kind: 'move', publishedAt: null },
    });
  });

  it('rejects archived reviews, unknown and archived stages', () => {
    expect(planStageMove({ ...review, archivedAt: '2026-10-01T00:00:00Z' }, stage(2), now)).toEqual({
      ok: false,
      error: 'archived',
    });
    expect(planStageMove(review, undefined, now)).toEqual({ ok: false, error: 'unknown_stage' });
    expect(planStageMove(review, stage(2, { archivedAt: '2026-10-01T00:00:00Z' }), now)).toEqual({
      ok: false,
      error: 'stage_archived',
    });
  });
});
