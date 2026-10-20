import { describe, expect, it } from 'vitest';
import { REVIEW_STALE_MESSAGE, toReviewForm } from '../../src/lib/review-form';
import { reviewUpdateSchema } from '../../src/lib/validation';
import type { ReviewDetail } from '../../src/server/db/reviews';

const review: ReviewDetail = {
  id: 7,
  productName: 'Northwind NX7',
  title: null,
  brandId: 2,
  brandName: 'Northwind',
  sourceType: 'loan',
  stageId: 3,
  stageName: '촬영',
  stageColor: '#000000',
  categoryKey: 'in_progress',
  isOnHold: false,
  priority: 'high',
  channels: ['youtube', 'blog'],
  receivedOn: '2026-10-01',
  shootOn: '2026-10-05',
  shootStartsAt: '2026-10-05T05:00:00.000Z', // 14:00 KST
  shootEndsAt: '2026-10-05T06:30:00.000Z', // 15:30 KST
  writeDueOn: '2026-10-09',
  publishPlannedOn: null,
  embargoUntil: '2026-10-11',
  publishedAt: '2026-10-12T00:15:00.000Z', // 09:15 KST
  publishedUrl: null,
  notesMd: '# 메모',
  templateId: null,
  archivedAt: null,
  updatedAt: '2026-10-12T00:15:00.123Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  version: 4,
};

describe('review form (shared by the detail page and the quick-edit peek)', () => {
  it('maps a stored review to form strings with KST wall-clock times', () => {
    expect(toReviewForm(review)).toEqual({
      productName: 'Northwind NX7',
      title: '',
      brandId: '2',
      sourceType: 'loan',
      stageId: '3',
      priority: 'high',
      channels: ['youtube', 'blog'],
      receivedOn: '2026-10-01',
      shootOn: '2026-10-05',
      shootStartTime: '14:00',
      shootEndTime: '15:30',
      writeDueOn: '2026-10-09',
      publishPlannedOn: '',
      embargoUntil: '2026-10-11',
      publishedAtLocal: '2026-10-12T09:15',
      publishedUrl: '',
      notesMd: '# 메모',
    });
  });

  it('an untouched form parses back to the stored values, so a peek save never drops fields it does not show', () => {
    const parsed = reviewUpdateSchema.parse(toReviewForm(review));
    expect(parsed).toMatchObject({
      title: null,
      brandId: 2,
      stageId: 3,
      channels: ['youtube', 'blog'],
      receivedOn: '2026-10-01',
      publishPlannedOn: null,
      publishedAtLocal: '2026-10-12T09:15',
      publishedUrl: null,
      notesMd: '# 메모',
    });
  });

  it('peek edits go through the same zod rules as the full page', () => {
    const result = reviewUpdateSchema.safeParse({ ...toReviewForm(review), publishPlannedOn: '2026-10-04' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ['publishPlannedOn'], message: '발행 예정일은 촬영일 이후여야 합니다.' });
  });

  it('stale message is the agreed Korean text', () => {
    expect(REVIEW_STALE_MESSAGE).toBe('다른 곳에서 수정되었습니다. 새로고침 후 다시 시도하세요.');
  });
});
