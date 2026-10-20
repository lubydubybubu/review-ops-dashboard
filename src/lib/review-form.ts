import type { ReviewDetail } from '@/server/db/reviews';
import { kstDateOf, kstTimeOf } from './domain/dates';
import type { Channel } from './domain/review';

/**
 * The review edit form as strings, exactly what `reviewUpdateSchema` parses. Shared by the full
 * detail page and the quick-edit peek: the peek edits a subset but always sends the whole form, so
 * both go through the same action, schema and DB rules.
 */
export interface ReviewFormState {
  productName: string;
  title: string;
  brandId: string;
  sourceType: string;
  stageId: string;
  priority: string;
  channels: Channel[];
  receivedOn: string;
  shootOn: string;
  shootStartTime: string;
  shootEndTime: string;
  writeDueOn: string;
  publishPlannedOn: string;
  embargoUntil: string;
  publishedAtLocal: string;
  publishedUrl: string;
  notesMd: string;
}

export function toReviewForm(r: ReviewDetail): ReviewFormState {
  return {
    productName: r.productName,
    title: r.title ?? '',
    brandId: r.brandId ? String(r.brandId) : '',
    sourceType: r.sourceType ?? '',
    stageId: String(r.stageId),
    priority: r.priority,
    channels: r.channels,
    receivedOn: r.receivedOn ?? '',
    shootOn: r.shootOn ?? '',
    shootStartTime: r.shootStartsAt ? kstTimeOf(r.shootStartsAt) : '',
    shootEndTime: r.shootEndsAt ? kstTimeOf(r.shootEndsAt) : '',
    writeDueOn: r.writeDueOn ?? '',
    publishPlannedOn: r.publishPlannedOn ?? '',
    embargoUntil: r.embargoUntil ?? '',
    publishedAtLocal: r.publishedAt ? `${kstDateOf(r.publishedAt)}T${kstTimeOf(r.publishedAt)}` : '',
    publishedUrl: r.publishedUrl ?? '',
    notesMd: r.notesMd,
  };
}

/** Shown when a save is refused because the review changed elsewhere since the form was loaded. */
export const REVIEW_STALE_MESSAGE = '다른 곳에서 수정되었습니다. 새로고침 후 다시 시도하세요.';
