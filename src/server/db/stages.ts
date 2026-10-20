import type { CategoryKey, Stage } from '@/lib/domain/review';
import type { Queryable } from './client';

const STAGE_COLUMNS = `
  s.id, s.name, s.color, s.category_key as "categoryKey", s.sort,
  s.is_default as "isDefault", s.is_on_hold as "isOnHold", s.archived_at as "archivedAt"`;

/** Review stages in board order: category order, then stage order inside the category. */
export async function listStages(db: Queryable, { includeArchived = false } = {}): Promise<Stage[]> {
  const { rows } = await db.query<Stage>(
    `select ${STAGE_COLUMNS}
       from workflow_stages s
       join stage_categories c on c.key = s.category_key
      where s.entity_type = 'review' and ($1 or s.archived_at is null)
      order by c.sort, s.sort`,
    [includeArchived],
  );
  return rows;
}

export async function getStage(db: Queryable, id: number): Promise<Stage | undefined> {
  const { rows } = await db.query<Stage>(
    `select ${STAGE_COLUMNS} from workflow_stages s where s.id = $1 and s.entity_type = 'review'`,
    [id],
  );
  return rows[0];
}

export async function getDefaultStage(db: Queryable): Promise<Stage> {
  const { rows } = await db.query<Stage>(
    `select ${STAGE_COLUMNS} from workflow_stages s where s.entity_type = 'review' and s.is_default`,
  );
  if (!rows[0]) throw new Error('no default review stage configured');
  return rows[0];
}

/** Add a stage at the end of a category (categories themselves are fixed). */
export async function createStage(
  db: Queryable,
  input: { categoryKey: CategoryKey; name: string; color: string },
): Promise<Stage> {
  const { rows } = await db.query<Stage>(
    `insert into workflow_stages (entity_type, category_key, name, color, sort)
     select 'review', $1, $2, $3, coalesce(max(sort), 0) + 1
       from workflow_stages where entity_type = 'review' and category_key = $1
     returning id, name, color, category_key as "categoryKey", sort,
               is_default as "isDefault", is_on_hold as "isOnHold", archived_at as "archivedAt"`,
    [input.categoryKey, input.name, input.color],
  );
  return rows[0]!;
}

export async function updateStage(db: Queryable, input: { id: number; name: string; color: string }): Promise<boolean> {
  const { rowCount } = await db.query(
    `update workflow_stages set name = $2, color = $3 where id = $1 and entity_type = 'review'`,
    [input.id, input.name, input.color],
  );
  return rowCount === 1;
}
