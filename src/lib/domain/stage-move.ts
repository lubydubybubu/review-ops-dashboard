import type { IsoInstant } from './dates';
import type { Stage } from './review';

export interface StageMoveSubject {
  stageId: number;
  publishedAt: IsoInstant | null;
  archivedAt: IsoInstant | null;
}

export type StageMovePlan =
  | { kind: 'noop' }
  | {
      kind: 'move';
      toStageId: number;
      /** set when the review enters a published (완료, not 보류) stage for the first time */
      publishedAt: IsoInstant | null;
    };

export type StageMoveError = 'archived' | 'unknown_stage' | 'stage_archived';

export type StageMoveResult = { ok: true; plan: StageMovePlan } | { ok: false; error: StageMoveError };

/**
 * Decide what a stage change does, without touching the database. The data layer
 * applies the plan inside a transaction; the history row is written by a DB trigger.
 */
export function planStageMove(
  review: StageMoveSubject,
  target: Stage | undefined,
  now: Date,
): StageMoveResult {
  if (review.archivedAt) return { ok: false, error: 'archived' };
  if (!target) return { ok: false, error: 'unknown_stage' };
  if (target.archivedAt) return { ok: false, error: 'stage_archived' };
  if (target.id === review.stageId) return { ok: true, plan: { kind: 'noop' } };

  const entersPublished = target.categoryKey === 'done' && !target.isOnHold;
  return {
    ok: true,
    plan: {
      kind: 'move',
      toStageId: target.id,
      publishedAt: entersPublished && !review.publishedAt ? now.toISOString() : null,
    },
  };
}

export const STAGE_MOVE_ERROR_MESSAGE: Record<StageMoveError, string> = {
  archived: '보관된 리뷰는 단계를 바꿀 수 없습니다.',
  unknown_stage: '없는 단계입니다.',
  stage_archived: '사용하지 않는 단계입니다.',
};
