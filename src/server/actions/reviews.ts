'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { todayInSeoul } from '@/lib/domain/dates';
import { STAGE_MOVE_ERROR_MESSAGE } from '@/lib/domain/stage-move';
import { REVIEW_STALE_MESSAGE } from '@/lib/review-form';
import {
  calendarRangeSchema,
  checklistAddSchema,
  checklistToggleSchema,
  dateMoveSchema,
  reviewCreateSchema,
  reviewUpdateSchema,
  searchSchema,
  stageMoveSchema,
} from '@/lib/validation';
import { listCalendarChips, type CalendarChip } from '../db/calendar';
import { addChecklistItem, deleteChecklistItem, listChecklist, setChecklistItemDone, type ChecklistItem } from '../db/checklist';
import { getPool } from '../db/pool';
import {
  createReview,
  getReview,
  moveReviewDate,
  moveReviewStage,
  NotFoundError,
  searchReviews,
  setReviewArchived,
  updateReview,
  type ReviewDetail,
  type ReviewSearchHit,
} from '../db/reviews';
import { runAction, type ActionResult } from './run';

const id = z.coerce.number().int().positive();
const instant = z.string().refine((v) => !Number.isNaN(Date.parse(v)), '시각 형식이 올바르지 않습니다.');

/** Reviews show up on every page, so mutations refresh the whole (small) app. */
function refreshAll() {
  revalidatePath('/', 'layout');
}

export async function createReviewAction(raw: unknown): Promise<ActionResult<{ id: number }>> {
  return runAction(reviewCreateSchema, raw, async (input) => {
    const reviewId = await createReview(getPool(), input);
    refreshAll();
    return { id: reviewId };
  });
}

/**
 * Save the review form (full page and quick-edit peek). `expectedUpdatedAt` is the `updatedAt` the form
 * was loaded with; if the review changed since, nothing is written and the stale message comes back.
 */
export async function updateReviewAction(
  reviewId: number,
  raw: unknown,
  expectedUpdatedAt?: string,
): Promise<ActionResult<{ updatedAt: string }>> {
  const result = await runAction(
    z.object({ id, input: reviewUpdateSchema, expectedUpdatedAt: instant.optional() }),
    { id: reviewId, input: raw, expectedUpdatedAt },
    (v) => updateReview(getPool(), v.id, v.input, new Date(), v.expectedUpdatedAt),
  );
  if (!result.ok) return result;
  if (!result.data.ok) {
    return { ok: false, error: result.data.error === 'stale' ? REVIEW_STALE_MESSAGE : STAGE_MOVE_ERROR_MESSAGE[result.data.error] };
  }
  refreshAll();
  return { ok: true, data: { updatedAt: result.data.updatedAt } };
}

export async function moveReviewStageAction(raw: unknown): Promise<ActionResult> {
  const result = await runAction(stageMoveSchema, raw, (v) => moveReviewStage(getPool(), v.reviewId, v.stageId));
  if (!result.ok) return result;
  if (!result.data.ok) return { ok: false, error: STAGE_MOVE_ERROR_MESSAGE[result.data.error] };
  refreshAll();
  return { ok: true, data: null };
}

export async function moveReviewDateAction(raw: unknown): Promise<ActionResult> {
  return runAction(dateMoveSchema, raw, async (input) => {
    await moveReviewDate(getPool(), input);
    refreshAll();
    return null;
  });
}

export async function setReviewArchivedAction(reviewId: number, archived: boolean): Promise<ActionResult> {
  return runAction(z.object({ id, archived: z.boolean() }), { id: reviewId, archived }, async (v) => {
    if (!(await setReviewArchived(getPool(), v.id, v.archived))) throw new NotFoundError('review');
    refreshAll();
    return null;
  });
}

// ------------------------------------------------------------- reads used by client views

export async function searchReviewsAction(q: string): Promise<ActionResult<ReviewSearchHit[]>> {
  return runAction(searchSchema, { q }, (v) => (v.q ? searchReviews(getPool(), v.q) : Promise.resolve([])));
}

/** Quick-edit peek: the review (with the `updatedAt` its save will be checked against) and its checklist. */
export async function reviewPeekAction(
  reviewId: number,
): Promise<ActionResult<{ review: ReviewDetail; checklist: ChecklistItem[] }>> {
  return runAction(z.object({ id }), { id: reviewId }, async (v) => {
    const db = getPool();
    const [review, checklist] = await Promise.all([getReview(db, v.id), listChecklist(db, v.id)]);
    if (!review) throw new NotFoundError('review');
    return { review, checklist };
  });
}

export async function calendarChipsAction(raw: unknown): Promise<ActionResult<CalendarChip[]>> {
  return runAction(calendarRangeSchema, raw, (range) => listCalendarChips(getPool(), range, todayInSeoul()));
}

// ------------------------------------------------------------- checklist

export async function addChecklistItemAction(raw: unknown): Promise<ActionResult<ChecklistItem>> {
  return runAction(checklistAddSchema, raw, async (v) => {
    const item = await addChecklistItem(getPool(), v.reviewId, v.title);
    revalidatePath(`/reviews/${v.reviewId}`);
    return item;
  });
}

export async function toggleChecklistItemAction(raw: unknown): Promise<ActionResult> {
  return runAction(checklistToggleSchema, raw, async (v) => {
    const reviewId = await setChecklistItemDone(getPool(), v.itemId, v.done);
    if (reviewId === null) throw new NotFoundError('checklist item');
    revalidatePath(`/reviews/${reviewId}`);
    return null;
  });
}

export async function deleteChecklistItemAction(itemId: number): Promise<ActionResult> {
  return runAction(z.object({ id }), { id: itemId }, async (v) => {
    const reviewId = await deleteChecklistItem(getPool(), v.id);
    if (reviewId === null) throw new NotFoundError('checklist item');
    revalidatePath(`/reviews/${reviewId}`);
    return null;
  });
}
