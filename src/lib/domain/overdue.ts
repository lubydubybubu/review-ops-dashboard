import { todayInSeoul, type IsoDate } from './dates';
import { CALENDAR_FIELD_META, type CalendarField, type CategoryKey } from './review';

/**
 * Overdue rule (R1.6): a deadline date (작성 마감, 발행 예정) is overdue when that KST day
 * has fully passed and the review's stage category is not 완료. The due day itself is
 * not overdue — it becomes overdue at 00:00 KST the next day. 보류 sits in 완료, so
 * on-hold reviews never show as overdue.
 */
export function isDateOverdue(
  field: CalendarField,
  date: IsoDate | null,
  categoryKey: CategoryKey,
  today: IsoDate,
): boolean {
  return date !== null && CALENDAR_FIELD_META[field].isDeadline && categoryKey !== 'done' && date < today;
}

export interface OverdueInput {
  categoryKey: CategoryKey;
  writeDueOn: IsoDate | null;
  publishPlannedOn: IsoDate | null;
}

/** Deadline fields that are overdue, earliest first. */
export function overdueFields(review: OverdueInput, today: IsoDate): CalendarField[] {
  const candidates: [CalendarField, IsoDate | null][] = [
    ['write_due', review.writeDueOn],
    ['publish_planned', review.publishPlannedOn],
  ];
  return candidates
    .filter(([field, date]) => isDateOverdue(field, date, review.categoryKey, today))
    .sort((a, b) => (a[1]! < b[1]! ? -1 : 1))
    .map(([field]) => field);
}

export function isReviewOverdue(review: OverdueInput, now: Date = new Date()): boolean {
  return overdueFields(review, todayInSeoul(now)).length > 0;
}
