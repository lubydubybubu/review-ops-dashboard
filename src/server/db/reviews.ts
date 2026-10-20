import { kstDateTimeLocal, kstInstant, kstTimeOf, type IsoDate, type IsoInstant } from '@/lib/domain/dates';
import type {
  CalendarField,
  CategoryKey,
  Channel,
  Priority,
  ReviewDates,
  SourceType,
} from '@/lib/domain/review';
import { planStageMove, type StageMoveError } from '@/lib/domain/stage-move';
import type { FILTER_FIELDS, SORT_KEYS } from '@/lib/review-filter';
import { applyTemplateOffsets } from '@/lib/domain/templates';
import type { DateMoveInput, ReviewCreateInput, ReviewUpdateInput } from '@/lib/validation';
import type { FilterRoot, SortSpec } from '@/lib/views';
import { likePattern, withTransaction, type Database, type Queryable } from './client';
import { getDefaultStage, getStage } from './stages';
import { getTemplate } from './templates';
import { compileFilter, compileOrder, sqlParams } from './view-sql';

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export interface ReviewListItem {
  id: number;
  productName: string;
  title: string | null;
  brandId: number | null;
  brandName: string | null;
  sourceType: SourceType | null;
  stageId: number;
  stageName: string;
  stageColor: string;
  categoryKey: CategoryKey;
  isOnHold: boolean;
  priority: Priority;
  channels: Channel[];
  receivedOn: IsoDate | null;
  shootOn: IsoDate | null;
  shootStartsAt: IsoInstant | null;
  shootEndsAt: IsoInstant | null;
  writeDueOn: IsoDate | null;
  publishPlannedOn: IsoDate | null;
  embargoUntil: IsoDate | null;
  publishedAt: IsoInstant | null;
  archivedAt: IsoInstant | null;
  updatedAt: IsoInstant;
}

export interface ReviewDetail extends ReviewListItem {
  publishedUrl: string | null;
  notesMd: string;
  templateId: number | null;
  createdAt: IsoInstant;
  /** row revision (bumped by a trigger on every update); a form save is checked against it */
  version: number;
}

const LIST_COLUMNS = `
  r.id, r.product_name as "productName", r.title, r.brand_id as "brandId", b.name as "brandName",
  r.source_type as "sourceType", r.stage_id as "stageId", s.name as "stageName", s.color as "stageColor",
  s.category_key as "categoryKey", s.is_on_hold as "isOnHold", r.priority, r.channels,
  r.received_on as "receivedOn", r.shoot_on as "shootOn", r.shoot_starts_at as "shootStartsAt",
  r.shoot_ends_at as "shootEndsAt", r.write_due_on as "writeDueOn",
  r.publish_planned_on as "publishPlannedOn", r.embargo_until as "embargoUntil",
  r.published_at as "publishedAt", r.archived_at as "archivedAt", r.updated_at as "updatedAt"`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, r.published_url as "publishedUrl", r.notes_md as "notesMd",
  r.template_id as "templateId", r.created_at as "createdAt", r.version`;

/** Joins for `r` (a reviews row; also the RETURNING set of the form save). */
const JOINS = `
  join workflow_stages s on s.id = r.stage_id
  join stage_categories c on c.key = s.category_key
  left join brands b on b.id = r.brand_id`;

const FROM = `from reviews r ${JOINS}`;

// ---------------------------------------------------------------- create

/**
 * Create a review, optionally from a template: the template presets source type and
 * stage, fills missing dates along its offset chain and copies its checklist.
 */
export async function createReview(db: Database, input: ReviewCreateInput): Promise<number> {
  return withTransaction(db, (tx) => createReviewInTx(tx, input));
}

/** What a caller other than quick create may fix up front (a mail request states its own dates). */
export interface ReviewCreateExtras {
  /** exact dates: no template offsets are applied when given */
  dates?: ReviewDates & { embargoUntil: IsoDate | null };
  /** appended to the template body */
  notesMd?: string;
}

/** createReview inside an existing transaction (the mail accept writes review + candidate together). */
export async function createReviewInTx(tx: Queryable, input: ReviewCreateInput, extras: ReviewCreateExtras = {}): Promise<number> {
  const template = input.templateId !== null ? await getTemplate(tx, input.templateId) : undefined;
  if (input.templateId !== null && !template) throw new NotFoundError('template');

  const anchored: Partial<ReviewDates> = {};
  if (input.anchorField && input.anchorDate) {
    const key = ({
      received: 'receivedOn',
      shoot: 'shootOn',
      write_due: 'writeDueOn',
      publish_planned: 'publishPlannedOn',
    } as const)[input.anchorField];
    anchored[key] = input.anchorDate;
  }
  const dates =
    extras.dates ??
    (template
      ? applyTemplateOffsets(anchored, template)
      : applyTemplateOffsets(anchored, { shootOffsetDays: null, writeOffsetDays: null, publishOffsetDays: null }));

  const stageId = input.stageId ?? template?.initialStageId ?? (await getDefaultStage(tx)).id;
  const body = template?.bodyMd ?? '';
  const notes = extras.notesMd ? [body, extras.notesMd].filter((s) => s.trim() !== '').join('\n\n') : body;

  const { rows } = await tx.query<{ id: number }>(
    `insert into reviews (product_name, brand_id, source_type, stage_id, received_on, shoot_on,
                          write_due_on, publish_planned_on, embargo_until, template_id, notes_md)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      input.productName,
      input.brandId,
      input.sourceType ?? template?.sourceType ?? null,
      stageId,
      dates.receivedOn,
      dates.shootOn,
      dates.writeDueOn,
      dates.publishPlannedOn,
      extras.dates?.embargoUntil ?? null,
      template?.id ?? null,
      notes,
    ],
  );
  const id = rows[0]!.id;

  if (template) {
    await tx.query(
      `insert into review_checklist_items (review_id, title, sort)
       select $1, title, sort from template_checklist_items where template_id = $2`,
      [id, template.id],
    );
  }
  return id;
}

// ---------------------------------------------------------------- read

export async function getReview(db: Queryable, id: number): Promise<ReviewDetail | undefined> {
  const { rows } = await db.query<ReviewDetail>(`select ${DETAIL_COLUMNS} ${FROM} where r.id = $1`, [id]);
  return rows[0];
}

export type ReviewSortKey = (typeof SORT_KEYS)[number];

// Closed map from sort key to SQL; user input only ever selects a key.
const SORT_SQL: Record<ReviewSortKey, string> = {
  product: 'lower(r.product_name)',
  brand: 'lower(b.name)',
  stage: 'c.sort %dir%, s.sort',
  priority: "array_position(array['high','normal','low'], r.priority)",
  received: 'r.received_on',
  shoot: 'r.shoot_on',
  write_due: 'r.write_due_on',
  publish_planned: 'r.publish_planned_on',
  updated: 'r.updated_at',
};

export type FilterDateField = (typeof FILTER_FIELDS)[number];

const DATE_FIELD_SQL: Record<FilterDateField, string> = {
  received: 'r.received_on',
  shoot: 'r.shoot_on',
  write_due: 'r.write_due_on',
  publish_planned: 'r.publish_planned_on',
  embargo: 'r.embargo_until',
};

export interface ReviewFilter {
  q?: string;
  stageId?: number;
  category?: CategoryKey;
  brandId?: number;
  dateField?: FilterDateField;
  /** inclusive */
  from?: IsoDate;
  /** inclusive */
  to?: IsoDate;
  archived?: boolean;
  /** only reviews overdue as of this KST day (SQL mirror of `overdueFields`) */
  overdueAsOf?: IsoDate;
  sort?: ReviewSortKey;
  dir?: 'asc' | 'desc';
  limit?: number;
}

export async function listReviews(db: Queryable, filter: ReviewFilter = {}): Promise<ReviewListItem[]> {
  const where: string[] = [filter.archived ? 'r.archived_at is not null' : 'r.archived_at is null'];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filter.q) {
    const p = param(likePattern(filter.q));
    where.push(`(r.product_name ilike ${p} or r.title ilike ${p} or b.name ilike ${p})`);
  }
  if (filter.stageId) where.push(`r.stage_id = ${param(filter.stageId)}`);
  if (filter.category) where.push(`s.category_key = ${param(filter.category)}`);
  if (filter.brandId) where.push(`r.brand_id = ${param(filter.brandId)}`);
  if (filter.dateField && (filter.from || filter.to)) {
    const column = DATE_FIELD_SQL[filter.dateField];
    if (filter.from) where.push(`${column} >= ${param(filter.from)}`);
    if (filter.to) where.push(`${column} <= ${param(filter.to)}`);
  }
  if (filter.overdueAsOf) {
    const p = param(filter.overdueAsOf);
    where.push(`s.category_key <> 'done' and (r.write_due_on < ${p} or r.publish_planned_on < ${p})`);
  }

  const dir = filter.dir === 'desc' ? 'desc' : 'asc';
  const sort = SORT_SQL[filter.sort ?? 'updated'].replace('%dir%', dir);
  const order = filter.sort ? `${sort} ${dir} nulls last, r.id` : 'r.updated_at desc, r.id desc';

  const { rows } = await db.query<ReviewListItem>(
    `select ${LIST_COLUMNS} ${FROM}
      where ${where.join(' and ')}
      order by ${order}
      limit ${param(filter.limit ?? 500)}`,
    params,
  );
  return rows;
}

/** Upper bound on rows a list/board view loads (same as the table before views). */
export const VIEW_ROW_LIMIT = 500;

/** Rows for a saved view (list / board): its filter and sorts compiled from closed maps, values bound. */
export async function listReviewsForView(
  db: Queryable,
  view: { filter: FilterRoot; sorts: readonly SortSpec[] },
  options: { today: IsoDate; archived?: boolean; limit?: number },
): Promise<ReviewListItem[]> {
  const { values, param } = sqlParams();
  const where = compileFilter(view.filter, { param, today: options.today });
  const { rows } = await db.query<ReviewListItem>(
    `select ${LIST_COLUMNS} ${FROM}
      where ${options.archived ? 'r.archived_at is not null' : 'r.archived_at is null'} and (${where})
      order by ${compileOrder(view.sorts)}
      limit ${param(options.limit ?? VIEW_ROW_LIMIT)}`,
    values,
  );
  return rows;
}

export interface ReviewSearchHit {
  id: number;
  productName: string;
  title: string | null;
  brandName: string | null;
  stageName: string;
  stageColor: string;
}

/** Command palette search: product name, working title or brand. */
export async function searchReviews(db: Queryable, q: string, limit = 8): Promise<ReviewSearchHit[]> {
  const { rows } = await db.query<ReviewSearchHit>(
    `select r.id, r.product_name as "productName", r.title, b.name as "brandName",
            s.name as "stageName", s.color as "stageColor"
     ${FROM}
     where r.archived_at is null
       and (r.product_name ilike $1 or r.title ilike $1 or b.name ilike $1)
     order by (r.product_name ilike $2) desc, r.updated_at desc
     limit $3`,
    [likePattern(q), `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit],
  );
  return rows;
}

export interface StageHistoryEntry {
  id: number;
  fromStageName: string | null;
  toStageName: string;
  toStageColor: string;
  changedAt: IsoInstant;
}

export async function getStageHistory(db: Queryable, reviewId: number): Promise<StageHistoryEntry[]> {
  const { rows } = await db.query<StageHistoryEntry>(
    `select h.id, f.name as "fromStageName", t.name as "toStageName", t.color as "toStageColor",
            h.changed_at as "changedAt"
       from review_stage_history h
       left join workflow_stages f on f.id = h.from_stage_id
       join workflow_stages t on t.id = h.to_stage_id
      where h.review_id = $1
      order by h.changed_at desc, h.id desc`,
    [reviewId],
  );
  return rows;
}

// ---------------------------------------------------------------- update

export type ReviewUpdateOutcome = { ok: true; review: ReviewDetail } | { ok: false; error: StageMoveError | 'stale' };

/**
 * Save the detail form. A stage change here is a stage move like any other.
 * Optimistic concurrency: with `expectedVersion` (the `version` the form was loaded with) the save is
 * refused as `stale` when the row changed since — another tab, a calendar drag, a board move. The UPDATE
 * itself carries the check (`where … and version = $n`); zero rows means stale and nothing is written.
 * Returns the saved row as stored (server rules applied, new version) for the caller's next form.
 */
export async function updateReview(
  db: Database,
  id: number,
  input: ReviewUpdateInput,
  now = new Date(),
  expectedVersion?: number,
): Promise<ReviewUpdateOutcome> {
  const stale = { ok: false as const, error: 'stale' as const };
  return withTransaction(db, async (tx) => {
    // The row lock is for the stage rules below (they read the current stage / publish time).
    const current = await lockReview(tx, id);
    // Checked early too, so a stale form gets `stale` rather than a stage error about a row it never saw.
    if (expectedVersion !== undefined && current.version !== expectedVersion) return stale;

    // The form holds minutes only: while it shows the stored instant's minute, keep the stored (precise)
    // instant; reconstruct it only when the owner changed or cleared it.
    const local = input.publishedAtLocal?.slice(0, 16) ?? null;
    let publishedAt =
      current.publishedAt && local === kstDateTimeLocal(current.publishedAt)
        ? current.publishedAt
        : local
          ? kstInstant(local.slice(0, 10), local.slice(11, 16))
          : null;

    if (input.stageId !== current.stageId) {
      const result = planStageMove({ ...current, publishedAt }, await getStage(tx, input.stageId), now);
      if (!result.ok) return { ok: false as const, error: result.error };
      if (result.plan.kind === 'move' && result.plan.publishedAt) publishedAt = result.plan.publishedAt;
    } else if (current.archivedAt) {
      return { ok: false as const, error: 'archived' as StageMoveError };
    }

    const startsAt = input.shootOn && input.shootStartTime ? kstInstant(input.shootOn, input.shootStartTime) : null;
    const endsAt = input.shootOn && input.shootEndTime ? kstInstant(input.shootOn, input.shootEndTime) : null;

    const { rows } = await tx.query<ReviewDetail>(
      `with r as (
         update reviews set
           product_name = $2, title = $3, brand_id = $4, source_type = $5, stage_id = $6,
           priority = $7, channels = $8, received_on = $9, shoot_on = $10, shoot_starts_at = $11,
           shoot_ends_at = $12, write_due_on = $13, publish_planned_on = $14, embargo_until = $15,
           published_at = $16, published_url = $17, notes_md = $18
         where id = $1 and ($19::integer is null or version = $19)
         returning *
       )
       select ${DETAIL_COLUMNS} from r ${JOINS}`,
      [
        id,
        input.productName,
        input.title,
        input.brandId,
        input.sourceType,
        input.stageId,
        input.priority,
        input.channels,
        input.receivedOn,
        input.shootOn,
        startsAt,
        endsAt,
        input.writeDueOn,
        input.publishPlannedOn,
        input.embargoUntil,
        publishedAt,
        input.publishedUrl,
        input.notesMd,
        expectedVersion ?? null,
      ],
    );
    return rows[0] ? { ok: true as const, review: rows[0] } : stale;
  });
}

interface LockedReview {
  stageId: number;
  publishedAt: IsoInstant | null;
  archivedAt: IsoInstant | null;
  shootOn: IsoDate | null;
  shootStartsAt: IsoInstant | null;
  shootEndsAt: IsoInstant | null;
  version: number;
}

async function lockReview(tx: Queryable, id: number): Promise<LockedReview> {
  const { rows } = await tx.query<LockedReview>(
    `select stage_id as "stageId", published_at as "publishedAt", archived_at as "archivedAt",
            shoot_on as "shootOn", shoot_starts_at as "shootStartsAt", shoot_ends_at as "shootEndsAt",
            version
       from reviews where id = $1 for update`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('review');
  return rows[0];
}

export type StageMoveOutcome = { ok: true; moved: boolean } | { ok: false; error: StageMoveError };

/**
 * Move a review to another stage inside an existing transaction. The row lock makes
 * concurrent moves serialize; the history row comes from the `reviews_log_stage_change`
 * trigger in the same statement, so stage and history commit or roll back together.
 */
export async function moveReviewStageInTx(
  tx: Queryable,
  reviewId: number,
  stageId: number,
  now: Date,
): Promise<StageMoveOutcome> {
  const current = await lockReview(tx, reviewId);
  const result = planStageMove(current, await getStage(tx, stageId), now);
  if (!result.ok) return result;
  if (result.plan.kind === 'noop') return { ok: true, moved: false };
  await tx.query(
    `update reviews set stage_id = $2, published_at = coalesce(published_at, $3) where id = $1`,
    [reviewId, result.plan.toStageId, result.plan.publishedAt],
  );
  return { ok: true, moved: true };
}

export function moveReviewStage(db: Database, reviewId: number, stageId: number, now = new Date()) {
  return withTransaction(db, (tx) => moveReviewStageInTx(tx, reviewId, stageId, now));
}

// Closed map: a calendar field names exactly one date column.
const SINGLE_DATE_COLUMN: Record<Exclude<CalendarField, 'shoot'>, string> = {
  write_due: 'write_due_on',
  publish_planned: 'publish_planned_on',
  embargo: 'embargo_until',
};

/**
 * Calendar drag: change exactly one date field. 촬영 is one logical field made of the
 * shoot day plus an optional time window; moving it keeps the time-of-day and duration
 * unless the drop supplies new times (week view).
 */
export async function moveReviewDate(db: Database, input: DateMoveInput): Promise<void> {
  if (input.field !== 'shoot') {
    const column = SINGLE_DATE_COLUMN[input.field];
    const { rowCount } = await db.query(
      `update reviews set ${column} = $2 where id = $1 and archived_at is null`,
      [input.reviewId, input.date],
    );
    if (rowCount !== 1) throw new NotFoundError('review');
    return;
  }

  await withTransaction(db, async (tx) => {
    const current = await lockReview(tx, input.reviewId);
    if (current.archivedAt) throw new NotFoundError('review');
    const { startsAt, endsAt } = movedShootWindow(current, input);
    await tx.query(
      `update reviews set shoot_on = $2, shoot_starts_at = $3, shoot_ends_at = $4 where id = $1`,
      [input.reviewId, input.date, startsAt, endsAt],
    );
  });
}

const HOUR_MS = 3_600_000;

function movedShootWindow(
  current: Pick<LockedReview, 'shootStartsAt' | 'shootEndsAt'>,
  input: DateMoveInput,
): { startsAt: IsoInstant | null; endsAt: IsoInstant | null } {
  const shift = (start: IsoInstant, ms: number) => new Date(Date.parse(start) + ms).toISOString();
  const duration =
    current.shootStartsAt && current.shootEndsAt
      ? Date.parse(current.shootEndsAt) - Date.parse(current.shootStartsAt)
      : null;

  if (input.startTime) {
    const startsAt = kstInstant(input.date, input.startTime);
    const endsAt = input.endTime ? kstInstant(input.date, input.endTime) : shift(startsAt, duration ?? HOUR_MS);
    return { startsAt, endsAt };
  }
  if (current.shootStartsAt) {
    const startsAt = kstInstant(input.date, kstTimeOf(current.shootStartsAt));
    return { startsAt, endsAt: duration === null ? null : shift(startsAt, duration) };
  }
  return { startsAt: null, endsAt: null };
}

export async function setReviewArchived(db: Queryable, id: number, archived: boolean): Promise<boolean> {
  const { rowCount } = await db.query(
    `update reviews set archived_at = case when $2 then coalesce(archived_at, now()) end where id = $1`,
    [id, archived],
  );
  return rowCount === 1;
}
