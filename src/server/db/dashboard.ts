import type { IsoDate } from '@/lib/domain/dates';
import type { Queryable } from './client';
import { listReviews, type ReviewListItem } from './reviews';

/**
 * Overdue reviews, most urgent deadline first. The SQL predicate mirrors the TypeScript
 * rule (`overdueFields`); an integration test keeps the two in sync.
 */
export function listOverdueReviews(db: Queryable, today: IsoDate): Promise<ReviewListItem[]> {
  return listReviews(db, { overdueAsOf: today, sort: 'write_due', dir: 'asc' });
}

export interface StageCount {
  stageId: number;
  count: number;
}

/** Active reviews per stage (stages with zero reviews included). */
export async function countReviewsByStage(db: Queryable): Promise<StageCount[]> {
  const { rows } = await db.query<StageCount>(
    `select s.id as "stageId", count(r.id) as count
       from workflow_stages s
       join stage_categories c on c.key = s.category_key
       left join reviews r on r.stage_id = s.id and r.archived_at is null
      where s.entity_type = 'review' and s.archived_at is null
      group by s.id, c.sort, s.sort
      order by c.sort, s.sort`,
  );
  return rows;
}
