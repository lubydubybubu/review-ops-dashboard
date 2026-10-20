import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayInSeoul } from '../../src/lib/domain/dates';
import { isDateOverdue, isReviewOverdue, overdueFields } from '../../src/lib/domain/overdue';

const review = (over: Partial<Parameters<typeof overdueFields>[0]> = {}) => ({
  categoryKey: 'in_progress' as const,
  writeDueOn: '2026-10-19',
  publishPlannedOn: '2026-10-22',
  ...over,
});

describe('overdue rule (R1.6) with a fixed clock', () => {
  afterEach(() => vi.useRealTimers());

  it('the due day itself is not overdue, up to 23:59:59 KST', () => {
    // 2026-10-19 23:59:59 KST = 14:59:59 UTC
    expect(isReviewOverdue(review(), new Date('2026-10-19T14:59:59Z'))).toBe(false);
  });

  it('becomes overdue at 00:00 KST the next day (15:00 UTC), not at UTC midnight', () => {
    expect(isReviewOverdue(review(), new Date('2026-10-19T15:00:00Z'))).toBe(true);
    // UTC midnight of the 20th is 09:00 KST on the 20th: still overdue, by then for 9 hours
    expect(isReviewOverdue(review(), new Date('2026-10-20T00:00:00Z'))).toBe(true);
  });

  it('a UTC-based rule would be wrong in the early KST morning', () => {
    // 2026-10-20 08:00 KST is still the 19th in UTC
    const now = new Date('2026-10-19T23:00:00Z');
    expect(now.toISOString().slice(0, 10)).toBe('2026-10-19');
    expect(todayInSeoul(now)).toBe('2026-10-20');
    expect(isReviewOverdue(review(), now)).toBe(true);
  });

  it('uses the system clock by default', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T14:59:59Z'));
    expect(isReviewOverdue(review())).toBe(false);
    vi.setSystemTime(new Date('2026-10-19T15:00:00Z'));
    expect(isReviewOverdue(review())).toBe(true);
  });

  it('완료 category (발행 and 보류) is never overdue', () => {
    const now = new Date('2026-12-01T00:00:00Z');
    expect(isReviewOverdue(review({ categoryKey: 'done' }), now)).toBe(false);
  });

  it('할 일 category is overdue too', () => {
    expect(isReviewOverdue(review({ categoryKey: 'todo' }), new Date('2026-10-21T00:00:00Z'))).toBe(true);
  });

  it('lists overdue deadline fields earliest first; missing dates are ignored', () => {
    expect(overdueFields(review(), '2026-10-25')).toEqual(['write_due', 'publish_planned']);
    expect(overdueFields(review({ writeDueOn: '2026-10-24', publishPlannedOn: '2026-10-21' }), '2026-10-25')).toEqual([
      'publish_planned',
      'write_due',
    ]);
    expect(overdueFields(review({ writeDueOn: null }), '2026-10-21')).toEqual([]);
    expect(overdueFields(review({ writeDueOn: null, publishPlannedOn: null }), '2030-01-01')).toEqual([]);
  });

  it('shoot and embargo dates are events, not deadlines', () => {
    expect(isDateOverdue('shoot', '2026-10-01', 'todo', '2026-10-19')).toBe(false);
    expect(isDateOverdue('embargo', '2026-10-01', 'in_progress', '2026-10-19')).toBe(false);
    expect(isDateOverdue('write_due', '2026-10-01', 'in_progress', '2026-10-19')).toBe(true);
  });
});
