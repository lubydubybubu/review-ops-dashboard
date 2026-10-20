import type { IsoInstant } from '@/lib/domain/dates';
import { defaultConfig, normalizeConfig, VIEW_NAME_MAX, type Layout, type ViewConfig } from '@/lib/views';
import { withTransaction, type Database, type Queryable } from './client';
import { NotFoundError } from './reviews';

export interface SavedViewSummary {
  id: number;
  layout: Layout;
  name: string;
  position: number;
  /** compare-and-set token for saving the config (bumped by a trigger when `config` changes) */
  version: number;
}

export interface SavedView extends SavedViewSummary {
  /** as stored: validate with `parseConfig` before use */
  config: unknown;
  updatedAt: IsoInstant;
}

const COLUMNS = `id, layout, name, position, version, config, updated_at as "updatedAt"`;

/**
 * Structural changes (create, duplicate, delete, reorder) take one transaction-scoped advisory lock,
 * so position arithmetic and the "last view of a layout" check never race each other.
 */
const STRUCTURE_LOCK = 4_202_610_20;
const lockStructure = (tx: Queryable) => tx.query('select pg_advisory_xact_lock($1)', [STRUCTURE_LOCK]);

/** All views in tab order (one shared tab bar). */
export async function listViews(db: Queryable): Promise<SavedView[]> {
  const { rows } = await db.query<SavedView>(`select ${COLUMNS} from saved_views order by position, id`);
  return rows;
}

export async function getView(db: Queryable, id: number): Promise<SavedView | undefined> {
  const { rows } = await db.query<SavedView>(`select ${COLUMNS} from saved_views where id = $1`, [id]);
  return rows[0];
}

/** A new tab at the end, with the layout's default settings or the given (validated) ones ("새 보기로 저장"). */
export async function createView(db: Database, input: { layout: Layout; name: string; config?: ViewConfig }): Promise<number> {
  return withTransaction(db, async (tx) => {
    await lockStructure(tx);
    const { rows } = await tx.query<{ id: number }>(
      `insert into saved_views (layout, name, position, config)
       values ($1, $2, (select coalesce(max(position) + 1, 0) from saved_views), $3)
       returning id`,
      [input.layout, input.name, input.config ? normalizeConfig(input.layout, input.config) : defaultConfig(input.layout)],
    );
    return rows[0]!.id;
  });
}

export async function renameView(db: Queryable, id: number, name: string): Promise<void> {
  const { rowCount } = await db.query('update saved_views set name = $2 where id = $1', [id, name]);
  if (rowCount !== 1) throw new NotFoundError('view');
}

/** `<name> 복사본` (then `복사본 2`, `3`, …) right after the original, with its saved settings. */
export async function duplicateView(db: Database, id: number): Promise<number> {
  return withTransaction(db, async (tx) => {
    await lockStructure(tx);
    const source = await getView(tx, id);
    if (!source) throw new NotFoundError('view');
    const { rows: taken } = await tx.query<{ name: string }>(
      'select lower(name) as name from saved_views where layout = $1',
      [source.layout],
    );
    const names = new Set(taken.map((r) => r.name));
    let name = '';
    for (let n = 1; n < 1000; n++) {
      const suffix = n === 1 ? ' 복사본' : ` 복사본 ${n}`;
      name = `${source.name.slice(0, VIEW_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
      if (!names.has(name.toLowerCase())) break;
    }
    // the unique position constraint is deferred, so shifting the tail in one statement is fine
    await tx.query('update saved_views set position = position + 1 where position > $1', [source.position]);
    const { rows } = await tx.query<{ id: number }>(
      `insert into saved_views (layout, name, position, config) values ($1, $2, $3, $4) returning id`,
      [source.layout, name, source.position + 1, source.config],
    );
    return rows[0]!.id;
  });
}

export type DeleteViewOutcome = { ok: true; layout: Layout } | { ok: false; error: 'last' };

/** Deletes a view unless it is the last one of its layout (every layout keeps at least one tab). */
export async function deleteView(db: Database, id: number): Promise<DeleteViewOutcome> {
  return withTransaction(db, async (tx) => {
    await lockStructure(tx);
    const view = await getView(tx, id);
    if (!view) throw new NotFoundError('view');
    const { rows } = await tx.query<{ n: number }>('select count(*)::int as n from saved_views where layout = $1', [
      view.layout,
    ]);
    if (rows[0]!.n <= 1) return { ok: false as const, error: 'last' as const };
    await tx.query('delete from saved_views where id = $1', [id]);
    return { ok: true as const, layout: view.layout };
  });
}

/** Swap a tab with its left / right neighbour. Returns false at either end. */
export async function moveView(db: Database, id: number, direction: 'left' | 'right'): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    await lockStructure(tx);
    const { rows } = await tx.query<{ id: number; position: number }>(
      'select id, position from saved_views order by position, id',
    );
    const index = rows.findIndex((r) => r.id === id);
    if (index < 0) throw new NotFoundError('view');
    const other = rows[direction === 'left' ? index - 1 : index + 1];
    if (!other) return false;
    const self = rows[index]!;
    await tx.query(
      `update saved_views set position = case id when $1 then $2::integer else $3::integer end where id in ($1, $4)`,
      [self.id, other.position, self.position, other.id],
    );
    return true;
  });
}

export type SaveViewOutcome = { ok: true; version: number } | { ok: false; error: 'stale' };

/**
 * Save a view's settings ("저장"). Compare-and-set like the review form: the UPDATE carries
 * `version = <the version the page was loaded with>`; zero rows means someone else saved (or the view
 * is gone) and nothing is written. The config is normalized for the view's own layout.
 */
export async function saveViewConfig(
  db: Queryable,
  id: number,
  expectedVersion: number,
  config: ViewConfig,
): Promise<SaveViewOutcome> {
  const view = await getView(db, id);
  if (!view) throw new NotFoundError('view');
  const { rows } = await db.query<{ version: number }>(
    'update saved_views set config = $3 where id = $1 and version = $2 returning version',
    [id, expectedVersion, normalizeConfig(view.layout, config)],
  );
  return rows[0] ? { ok: true, version: rows[0].version } : { ok: false, error: 'stale' };
}
