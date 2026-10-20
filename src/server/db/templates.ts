import type { SourceType } from '@/lib/domain/review';
import type { TemplateUpdateInput } from '@/lib/validation';
import { withTransaction, type Database, type Queryable } from './client';

export interface ReviewTemplate {
  id: number;
  name: string;
  sourceType: SourceType | null;
  initialStageId: number | null;
  shootOffsetDays: number | null;
  writeOffsetDays: number | null;
  publishOffsetDays: number | null;
  bodyMd: string;
  checklist: string[];
}

const TEMPLATE_SELECT = `
  select t.id, t.name, t.source_type as "sourceType", t.initial_stage_id as "initialStageId",
         t.shoot_offset_days as "shootOffsetDays", t.write_offset_days as "writeOffsetDays",
         t.publish_offset_days as "publishOffsetDays", t.body_md as "bodyMd",
         coalesce(array_agg(i.title order by i.sort) filter (where i.id is not null), '{}') as checklist
    from templates t
    left join template_checklist_items i on i.template_id = t.id`;

export async function listTemplates(db: Queryable): Promise<ReviewTemplate[]> {
  const { rows } = await db.query<ReviewTemplate>(
    `${TEMPLATE_SELECT}
      where t.entity_type = 'review' and t.archived_at is null
      group by t.id
      order by t.sort, t.id`,
  );
  return rows;
}

export async function getTemplate(db: Queryable, id: number): Promise<ReviewTemplate | undefined> {
  const { rows } = await db.query<ReviewTemplate>(
    `${TEMPLATE_SELECT}
      where t.id = $1 and t.entity_type = 'review' and t.archived_at is null
      group by t.id`,
    [id],
  );
  return rows[0];
}

/** Update a template and replace its checklist in one transaction. */
export async function updateTemplate(db: Database, input: TemplateUpdateInput): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const { rowCount } = await tx.query(
      `update templates
          set name = $2, source_type = $3, initial_stage_id = $4, shoot_offset_days = $5,
              write_offset_days = $6, publish_offset_days = $7, body_md = $8
        where id = $1 and entity_type = 'review'`,
      [
        input.id,
        input.name,
        input.sourceType,
        input.initialStageId,
        input.shootOffsetDays,
        input.writeOffsetDays,
        input.publishOffsetDays,
        input.bodyMd,
      ],
    );
    if (rowCount !== 1) return false;
    await tx.query('delete from template_checklist_items where template_id = $1', [input.id]);
    await tx.query(
      `insert into template_checklist_items (template_id, title, sort)
       select $1, title, ord from unnest($2::text[]) with ordinality as u(title, ord)`,
      [input.id, input.checklist],
    );
    return true;
  });
}
