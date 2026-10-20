import type { IsoDate, IsoInstant } from '@/lib/domain/dates';
import { isDateOverdue } from '@/lib/domain/overdue';
import type { CalendarField, CategoryKey } from '@/lib/domain/review';
import type { Queryable } from './client';

/** One date field of one review, as drawn on the calendar. */
export interface CalendarChip {
  reviewId: number;
  field: CalendarField;
  date: IsoDate;
  /** only for a timed 촬영 */
  startsAt: IsoInstant | null;
  endsAt: IsoInstant | null;
  productName: string;
  brandName: string | null;
  stageName: string;
  categoryKey: CategoryKey;
  isOnHold: boolean;
  overdue: boolean;
}

const CHIP_COLUMNS = `
  r.id as "reviewId", r.product_name as "productName", b.name as "brandName",
  s.name as "stageName", s.category_key as "categoryKey", s.is_on_hold as "isOnHold"`;

const CHIP_FROM = `
  from reviews r
  join workflow_stages s on s.id = r.stage_id
  left join brands b on b.id = r.brand_id`;

/**
 * Chips for [from, to) restricted to the chosen fields. One UNION ALL branch per date
 * column so each branch can use that column's partial index; a branch whose field is
 * not requested is switched off by its first predicate (planned away with custom plans).
 */
export async function listCalendarChips(
  db: Queryable,
  range: { from: IsoDate; to: IsoDate; fields: readonly CalendarField[] },
  today: IsoDate,
): Promise<CalendarChip[]> {
  if (range.fields.length === 0) return [];
  const { rows } = await db.query<Omit<CalendarChip, 'overdue'>>(
    `select 'shoot' as field, r.shoot_on as date, r.shoot_starts_at as "startsAt",
            r.shoot_ends_at as "endsAt", ${CHIP_COLUMNS}
     ${CHIP_FROM}
     where 'shoot' = any($3::text[]) and r.archived_at is null
       and r.shoot_on >= $1 and r.shoot_on < $2
     union all
     select 'write_due', r.write_due_on, null, null, ${CHIP_COLUMNS}
     ${CHIP_FROM}
     where 'write_due' = any($3::text[]) and r.archived_at is null
       and r.write_due_on >= $1 and r.write_due_on < $2
     union all
     select 'publish_planned', r.publish_planned_on, null, null, ${CHIP_COLUMNS}
     ${CHIP_FROM}
     where 'publish_planned' = any($3::text[]) and r.archived_at is null
       and r.publish_planned_on >= $1 and r.publish_planned_on < $2
     union all
     select 'embargo', r.embargo_until, null, null, ${CHIP_COLUMNS}
     ${CHIP_FROM}
     where 'embargo' = any($3::text[]) and r.archived_at is null
       and r.embargo_until >= $1 and r.embargo_until < $2
     order by date, "startsAt" nulls first, field, "productName"`,
    [range.from, range.to, range.fields],
  );
  return rows.map((chip) => ({
    ...chip,
    overdue: isDateOverdue(chip.field, chip.date, chip.categoryKey, today),
  }));
}
