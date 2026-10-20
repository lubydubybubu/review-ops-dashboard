import type { IsoInstant } from '@/lib/domain/dates';
import type { Queryable } from './client';

export interface ChecklistItem {
  id: number;
  title: string;
  sort: number;
  doneAt: IsoInstant | null;
}

export async function listChecklist(db: Queryable, reviewId: number): Promise<ChecklistItem[]> {
  const { rows } = await db.query<ChecklistItem>(
    `select id, title, sort, done_at as "doneAt"
       from review_checklist_items where review_id = $1 order by sort, id`,
    [reviewId],
  );
  return rows;
}

export async function addChecklistItem(db: Queryable, reviewId: number, title: string): Promise<ChecklistItem> {
  const { rows } = await db.query<ChecklistItem>(
    `insert into review_checklist_items (review_id, title, sort)
     select $1, $2, coalesce(max(sort), 0) + 1 from review_checklist_items where review_id = $1
     returning id, title, sort, done_at as "doneAt"`,
    [reviewId, title],
  );
  return rows[0]!;
}

/** Returns the review id so the caller can revalidate its page. */
export async function setChecklistItemDone(db: Queryable, itemId: number, done: boolean): Promise<number | null> {
  const { rows } = await db.query<{ reviewId: number }>(
    `update review_checklist_items
        set done_at = case when $2 then coalesce(done_at, now()) end
      where id = $1
      returning review_id as "reviewId"`,
    [itemId, done],
  );
  return rows[0]?.reviewId ?? null;
}

export async function deleteChecklistItem(db: Queryable, itemId: number): Promise<number | null> {
  const { rows } = await db.query<{ reviewId: number }>(
    `delete from review_checklist_items where id = $1 returning review_id as "reviewId"`,
    [itemId],
  );
  return rows[0]?.reviewId ?? null;
}
