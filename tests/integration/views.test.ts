import type pg from 'pg';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { todayInSeoul } from '../../src/lib/domain/dates';
import { CALENDAR_FIELDS } from '../../src/lib/domain/review';
import { defaultConfig, LAYOUTS, parseConfig, serializeConfig, type FilterRoot, type ViewConfig } from '../../src/lib/views';
import { listCalendarChips } from '../../src/server/db/calendar';
import type { Queryable } from '../../src/server/db/client';
import { friendlyDbError } from '../../src/server/db/errors';
import { listReviewsForView } from '../../src/server/db/reviews';
import { seedDemo } from '../../src/server/db/seed';
import { resolveViewFrom } from '../../src/server/view-resolve';
import {
  createView,
  deleteView,
  duplicateView,
  getView,
  listViews,
  moveView,
  renameView,
  saveViewConfig,
} from '../../src/server/db/views';
import { pgErrorCode, resetData, useAdminPool, useAppPool } from './helpers';

const SEEDED = [
  { layout: 'list', name: '전체 리뷰' },
  { layout: 'board', name: '진행 보드' },
  { layout: 'calendar', name: '캘린더' },
] as const;

/** Back to exactly the three migration defaults (identity keeps counting; ids are never assumed). */
async function resetViews(admin: pg.Pool) {
  await admin.query('delete from saved_views');
  for (const [position, v] of SEEDED.entries()) {
    await admin.query('insert into saved_views (layout, name, position, config) values ($1, $2, $3, $4)', [
      v.layout,
      v.name,
      position,
      defaultConfig(v.layout),
    ]);
  }
}

const viewOf = async (db: Queryable, layout: string) => (await listViews(db)).find((v) => v.layout === layout)!;

describe('saved views: migration defaults', () => {
  const db = useAppPool();

  it('seeds 전체 리뷰 (list), 진행 보드 (board by stage), 캘린더 (calendar) that reproduce the old screens', async () => {
    const views = await listViews(db);
    expect(views.map((v) => [v.layout, v.name, v.position, v.version])).toEqual([
      ['list', '전체 리뷰', 0, 1],
      ['board', '진행 보드', 1, 1],
      ['calendar', '캘린더', 2, 1],
    ]);
    for (const v of views) {
      const config = parseConfig(v.layout, v.config);
      expect(config, v.name).not.toBeNull();
      // the calendar view took the owner's calendar fields from user_settings (all four by default)
      expect(config).toEqual(v.layout === 'calendar' ? { ...defaultConfig('calendar'), calendarFields: [...CALENDAR_FIELDS] } : defaultConfig(v.layout));
    }
    expect(parseConfig('board', views[1]!.config)!.groupBy).toBe('stage');
  });
});

describe('saved views: CRUD, order, protection, concurrency', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetViews(admin));

  it('creates (appended, default config), renames, duplicates (next to the original), deletes', async () => {
    const id = await createView(db, { layout: 'board', name: '브랜드별' });
    let views = await listViews(db);
    expect(views.at(-1)).toMatchObject({ id, layout: 'board', name: '브랜드별', position: 3 });
    expect(parseConfig('board', views.at(-1)!.config)).toEqual(defaultConfig('board'));

    await renameView(db, id, '브랜드 보드');
    expect((await getView(db, id))!.name).toBe('브랜드 보드');

    const list = await viewOf(db, 'list');
    const copy = await duplicateView(db, list.id);
    const copy2 = await duplicateView(db, list.id);
    views = await listViews(db);
    expect(views.map((v) => v.name)).toEqual(['전체 리뷰', '전체 리뷰 복사본 2', '전체 리뷰 복사본', '진행 보드', '캘린더', '브랜드 보드']);
    expect(views.map((v) => v.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect([copy, copy2].every((x) => views.some((v) => v.id === x))).toBe(true);

    expect(await deleteView(db, copy)).toEqual({ ok: true, layout: 'list' });
    expect(await getView(db, copy)).toBeUndefined();
  });

  it('names are unique per layout (case-insensitive) with a Korean message; the same name in another layout is fine', async () => {
    const error = await createView(db, { layout: 'list', name: '전체 리뷰' }).catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe('23505');
    expect(friendlyDbError(error)).toBe('같은 이름의 보기가 이미 있습니다.');
    await expect(createView(db, { layout: 'board', name: '전체 리뷰' })).resolves.toBeGreaterThan(0);
    await expect(db.query(`update saved_views set name = '  ' where layout = 'list'`)).rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
  });

  it('reorders by swapping with a neighbour; the ends are no-ops', async () => {
    const [list, board, calendar] = await listViews(db);
    expect(await moveView(db, board!.id, 'left')).toBe(true);
    expect((await listViews(db)).map((v) => v.id)).toEqual([board!.id, list!.id, calendar!.id]);
    expect(await moveView(db, board!.id, 'left')).toBe(false);
    expect(await moveView(db, calendar!.id, 'right')).toBe(false);
    expect(await moveView(db, list!.id, 'right')).toBe(true);
    expect((await listViews(db)).map((v) => v.id)).toEqual([board!.id, calendar!.id, list!.id]);
    // reordering never invalidates an open draft (version unchanged)
    expect((await listViews(db)).map((v) => v.version)).toEqual([1, 1, 1]);
  });

  it('keeps at least one view per layout, also under concurrent deletes', async () => {
    for (const layout of LAYOUTS) {
      expect(await deleteView(db, (await viewOf(db, layout)).id)).toEqual({ ok: false, error: 'last' });
    }
    const second = await createView(db, { layout: 'board', name: '두 번째' });
    const first = (await viewOf(db, 'board')).id;
    const outcomes = await Promise.all([deleteView(db, first), deleteView(db, second)]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect((await listViews(db)).filter((v) => v.layout === 'board')).toHaveLength(1);
  });

  it('saving settings is compare-and-set on version: a stale save is refused and writes nothing', async () => {
    const list = await viewOf(db, 'list');
    const mine: ViewConfig = { ...defaultConfig('list'), groupBy: 'brand' };
    const theirs: ViewConfig = { ...defaultConfig('list'), sorts: [{ prop: 'shoot', dir: 'desc' }] };
    expect(await saveViewConfig(db, list.id, 1, theirs)).toEqual({ ok: true, version: 2 });
    expect(await saveViewConfig(db, list.id, 1, mine)).toEqual({ ok: false, error: 'stale' });
    expect(parseConfig('list', (await getView(db, list.id))!.config)).toEqual(theirs);
    // a rename is not a settings change: the version (and so the open draft) stays valid
    await renameView(db, list.id, '이름만 바꿈');
    expect(await saveViewConfig(db, list.id, 2, mine)).toEqual({ ok: true, version: 3 });
    // two tabs saving different changes from the same version at once: exactly one wins
    const a: ViewConfig = { ...defaultConfig('list'), groupBy: 'priority' };
    const b: ViewConfig = { ...defaultConfig('list'), groupBy: 'stage' };
    const raced = await Promise.all([saveViewConfig(db, list.id, 3, a), saveViewConfig(db, list.id, 3, b)]);
    expect(raced.filter((r) => r.ok)).toHaveLength(1);
    expect((await getView(db, list.id))!.version).toBe(4);
    // re-saving identical settings changes nothing, so it does not bump the version (no edit can be lost)
    const stored = parseConfig('list', (await getView(db, list.id))!.config)!;
    expect(await saveViewConfig(db, list.id, 4, stored)).toEqual({ ok: true, version: 4 });
  });

  it('"새 보기로 저장" creates a view with the given settings (normalized), leaving the source view alone', async () => {
    const list = await viewOf(db, 'list');
    const draft: ViewConfig = { ...defaultConfig('list'), groupBy: 'brand', calendarFields: ['shoot'] };
    const id = await createView(db, { layout: 'list', name: '브랜드별 표', config: draft });
    expect((await getView(db, id))!.config).toEqual({ ...draft, calendarFields: [] });
    expect((await getView(db, id))!.version).toBe(1);
    expect(await getView(db, list.id)).toMatchObject({ version: list.version, config: list.config });
  });

  it('stores the config normalized for the view’s layout', async () => {
    const calendar = await viewOf(db, 'calendar');
    await saveViewConfig(db, calendar.id, 1, { ...defaultConfig('list'), groupBy: 'brand', calendarFields: ['embargo', 'shoot'] });
    expect((await getView(db, calendar.id))!.config).toEqual({ ...defaultConfig('calendar'), calendarFields: ['shoot', 'embargo'] });
  });

  it('runtime role has DML on saved_views but cannot change its definition', async () => {
    await expect(db.query('alter table saved_views add column x int')).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
    await expect(db.query('drop trigger saved_views_bump_version on saved_views')).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
  });
});

describe('saved views: resolving a page (fallbacks)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetViews(admin));

  it('an invalid stored config falls back to the layout default with a notice, and the query still runs', async () => {
    const list = await viewOf(db, 'list');
    await admin.query(`update saved_views set config = $2 where id = $1`, [
      list.id,
      { v: 1, filter: { op: 'and', rules: [{ prop: 'notes_md', op: 'contains', value: 'x' }] }, sorts: 'nope' },
    ]);
    const resolved = resolveViewFrom(await listViews(db), 'list', {});
    expect('redirect' in resolved).toBe(false);
    if ('redirect' in resolved) return;
    expect(resolved.view?.id).toBe(list.id);
    expect(resolved.saved).toEqual(defaultConfig('list'));
    expect(resolved.effective).toEqual(defaultConfig('list'));
    expect(resolved.notices.join()).toMatch(/읽지 못해 기본 설정/);
    await expect(listReviewsForView(db, resolved.effective, { today: todayInSeoul() })).resolves.toBeInstanceOf(Array);
  });

  it('unknown id → first view of the layout; another layout’s id → redirect; bad draft → saved config', async () => {
    const views = await listViews(db);
    const board = views.find((v) => v.layout === 'board')!;
    const unknown = resolveViewFrom(views, 'list', { v: '999999' });
    expect('redirect' in unknown ? null : [unknown.view?.name, unknown.notices.length]).toEqual(['전체 리뷰', 1]);
    expect(resolveViewFrom(views, 'list', { v: String(board.id), cfg: '{"x":1}' })).toEqual({ redirect: `/board?v=${board.id}&cfg=%7B%22x%22%3A1%7D` });
    const bad = resolveViewFrom(views, 'board', { v: String(board.id), cfg: '{"v":1,"filter":"drop"}' });
    expect('redirect' in bad ? null : [bad.effective, bad.notices.length]).toEqual([defaultConfig('board'), 1]);
    const draft = { ...defaultConfig('board'), groupBy: 'brand' as const };
    const good = resolveViewFrom(views, 'board', { v: String(board.id), cfg: serializeConfig(draft) });
    expect('redirect' in good ? null : [good.effective, good.saved, good.notices]).toEqual([draft, defaultConfig('board'), []]);
    // old table links become a draft of the default table view
    const legacy = resolveViewFrom(views, 'list', { stage: '3' });
    expect('redirect' in legacy ? null : legacy.effective.filter.rules).toEqual([{ prop: 'stage', op: 'is', value: 3 }]);
  });
});

describe('saved views: filters return what hand-written SQL returns (demo seed)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  const today = todayInSeoul();
  let brand = 0;

  beforeAll(async () => {
    await resetData(admin);
    await seedDemo(db, today);
    brand = (await db.query<{ id: number }>(`select id from brands where name = 'Northwind Audio'`)).rows[0]!.id;
  });

  const ids = async (filter: FilterRoot) =>
    (await listReviewsForView(db, { filter, sorts: [] }, { today })).map((r) => r.id).sort((a, b) => a - b);
  const hand = async (where: string, params: unknown[] = []) =>
    (
      await db.query<{ id: number }>(
        `select r.id from reviews r join workflow_stages s on s.id = r.stage_id left join brands b on b.id = r.brand_id
          where r.archived_at is null and (${where}) order by r.id`,
        params,
      )
    ).rows.map((r) => r.id);

  const cases: [string, () => FilterRoot, string, () => unknown[]][] = [
    ['category is in_progress', () => ({ op: 'and', rules: [{ prop: 'stage_category', op: 'is', value: 'in_progress' }] }), `s.category_key = 'in_progress'`, () => []],
    ['brand is Northwind OR priority high', () => ({ op: 'or', rules: [{ prop: 'brand', op: 'is', value: brand }, { prop: 'priority', op: 'is', value: 'high' }] }), `r.brand_id = $1 or r.priority = 'high'`, () => [brand]],
    ['brand is not Northwind (keeps no-brand rows)', () => ({ op: 'and', rules: [{ prop: 'brand', op: 'is_not', value: brand }] }), `r.brand_id is null or r.brand_id <> $1`, () => [brand]],
    ['overdue', () => ({ op: 'and', rules: [{ prop: 'overdue', op: 'is', value: true }] }), `s.category_key <> 'done' and (r.write_due_on < $1 or r.publish_planned_on < $1)`, () => [today]],
    ['not overdue', () => ({ op: 'and', rules: [{ prop: 'overdue', op: 'is', value: false }] }), `not (s.category_key <> 'done' and (coalesce(r.write_due_on < $1, false) or coalesce(r.publish_planned_on < $1, false)))`, () => [today]],
    ['publish within next 7 days', () => ({ op: 'and', rules: [{ prop: 'publish_planned', op: 'within_next_days', value: 7 }] }), `r.publish_planned_on between $1::date and $1::date + 7`, () => [today]],
    ['shoot within past 3 days', () => ({ op: 'and', rules: [{ prop: 'shoot', op: 'within_past_days', value: 3 }] }), `r.shoot_on between $1::date - 3 and $1::date`, () => [today]],
    ['write due before today', () => ({ op: 'and', rules: [{ prop: 'write_due', op: 'before', value: 'today' }] }), `r.write_due_on < $1`, () => [today]],
    ['received on or after today', () => ({ op: 'and', rules: [{ prop: 'received', op: 'on_or_after', value: 'today' }] }), `r.received_on >= $1`, () => [today]],
    ['embargo not empty', () => ({ op: 'and', rules: [{ prop: 'embargo', op: 'is_not_empty' }] }), `r.embargo_until is not null`, () => []],
    ['product contains kestrel (case-insensitive)', () => ({ op: 'and', rules: [{ prop: 'product', op: 'contains', value: 'kestrel' }] }), `lower(r.product_name) like '%kestrel%'`, () => []],
    ['title is empty', () => ({ op: 'and', rules: [{ prop: 'title', op: 'is_empty' }] }), `r.title is null`, () => []],
    ['youtube and not a loan', () => ({ op: 'and', rules: [{ prop: 'channel', op: 'contains', value: 'youtube' }, { prop: 'source_type', op: 'is_not', value: 'loan' }] }), `'youtube' = any(r.channels) and r.source_type is distinct from 'loan'`, () => []],
    ['no channels', () => ({ op: 'and', rules: [{ prop: 'channel', op: 'is_empty' }] }), `r.channels = '{}'`, () => []],
    ['not done AND (no brand OR has embargo)', () => ({ op: 'and', rules: [{ prop: 'stage_category', op: 'is_not', value: 'done' }, { op: 'or', rules: [{ prop: 'brand', op: 'is_empty' }, { prop: 'embargo', op: 'is_not_empty' }] }] }), `s.category_key <> 'done' and (r.brand_id is null or r.embargo_until is not null)`, () => []],
    ['(gift AND high) OR (loan AND low)', () => ({ op: 'or', rules: [{ op: 'and', rules: [{ prop: 'source_type', op: 'is', value: 'gift' }, { prop: 'priority', op: 'is', value: 'high' }] }, { op: 'and', rules: [{ prop: 'source_type', op: 'is', value: 'purchase' }, { prop: 'priority', op: 'is', value: 'low' }] }] }), `(r.source_type = 'gift' and r.priority = 'high') or (r.source_type = 'purchase' and r.priority = 'low')`, () => []],
  ];

  it.each(cases)('%s', async (_label, filter, where, params) => {
    const expected = await hand(where, params());
    expect(await ids(filter())).toEqual(expected);
  });

  it('the cases are not vacuous (most select a proper, non-empty subset)', async () => {
    const all = (await hand('true')).length;
    let proper = 0;
    for (const [, filter] of cases) {
      const n = (await ids(filter())).length;
      if (n > 0 && n < all) proper++;
    }
    expect(all).toBeGreaterThan(10);
    expect(proper).toBeGreaterThanOrEqual(cases.length - 2);
  });

  it('injection-shaped text is only ever a value', async () => {
    expect(await ids({ op: 'and', rules: [{ prop: 'product', op: 'contains', value: "x'; drop table reviews; --" }] })).toEqual([]);
    expect(await ids({ op: 'and', rules: [{ prop: 'title', op: 'not_contains', value: "') or true --" }] })).toEqual(await hand('true'));
    expect((await db.query('select count(*)::int as n from reviews')).rows[0].n).toBeGreaterThan(10);
  });

  it('multi-sort order equals the hand-written ORDER BY', async () => {
    const rows = await listReviewsForView(
      db,
      { filter: { op: 'and', rules: [] }, sorts: [{ prop: 'stage', dir: 'asc' }, { prop: 'publish_planned', dir: 'desc' }, { prop: 'product', dir: 'asc' }] },
      { today },
    );
    const expected = await db.query<{ id: number }>(
      `select r.id from reviews r join workflow_stages s on s.id = r.stage_id join stage_categories c on c.key = s.category_key
        where r.archived_at is null
        order by c.sort asc nulls last, s.sort asc nulls last, r.publish_planned_on desc nulls last, lower(r.product_name) asc nulls last, r.id`,
    );
    expect(rows.map((r) => r.id)).toEqual(expected.rows.map((r) => r.id));
  });

  it('bounds the result size', async () => {
    expect(await listReviewsForView(db, { filter: { op: 'and', rules: [] }, sorts: [] }, { today, limit: 3 })).toHaveLength(3);
  });

  it('a calendar view’s filter applies to every date field branch', async () => {
    const range = { from: '2000-01-01', to: '2100-01-01', fields: CALENDAR_FIELDS };
    const chips = await listCalendarChips(db, { ...range, filter: { op: 'and', rules: [{ prop: 'brand', op: 'is', value: brand }] } }, today);
    const expected = await db.query<{ n: number }>(
      `select (count(shoot_on) + count(write_due_on) + count(publish_planned_on) + count(embargo_until))::int as n
         from reviews where archived_at is null and brand_id = $1`,
      [brand],
    );
    expect(chips.length).toBe(expected.rows[0]!.n);
    expect(new Set(chips.map((c) => c.brandName))).toEqual(new Set(['Northwind Audio']));
    const unfiltered = await listCalendarChips(db, range, today);
    expect(unfiltered.length).toBeGreaterThan(chips.length);
  });
});

describe('saved views: query plans at a realistic size (index decision)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  const today = todayInSeoul();

  beforeAll(async () => {
    await resetData(admin);
    await seedDemo(db, today);
    // ~5,000 extra reviews: far beyond a single creator's lifetime volume
    await admin.query(
      `insert into reviews (product_name, stage_id, brand_id, priority, source_type, channels, write_due_on, publish_planned_on)
       select 'Bulk ' || g,
              (select id from workflow_stages where entity_type = 'review' order by id offset g % 7 limit 1),
              (select id from brands order by id offset g % 6 limit 1),
              (array['high','normal','low'])[1 + g % 3],
              (array['loan','gift','purchase'])[1 + g % 3],
              case when g % 2 = 0 then array['youtube'] else array['blog'] end,
              $1::date + (g % 400) - 200,
              $1::date + (g % 400) - 195
         from generate_series(1, 5000) g`,
      [today],
    );
    await admin.query('analyze reviews');
  });

  /** A Queryable that EXPLAIN ANALYZEs whatever the data layer sends (same text, same parameters). */
  function explaining(plans: { ms: number; nodes: string[] }[]): Queryable {
    return {
      query: (async (text: string, values?: unknown[]) => {
        const { rows } = await db.query(`explain (analyze, format json) ${text}`, values);
        const plan = (rows[0] as { 'QUERY PLAN': [{ Plan: PlanNode; 'Execution Time': number }] })['QUERY PLAN'][0];
        const nodes: string[] = [];
        const walk = (n: PlanNode) => {
          nodes.push(`${n['Node Type']}${n['Index Name'] ? `(${n['Index Name']})` : n['Relation Name'] ? `(${n['Relation Name']})` : ''}`);
          n.Plans?.forEach(walk);
        };
        walk(plan.Plan);
        plans.push({ ms: plan['Execution Time'], nodes });
        return { rows: [] };
      }) as unknown as Queryable['query'],
    };
  }
  interface PlanNode {
    'Node Type': string;
    'Relation Name'?: string;
    'Index Name'?: string;
    Plans?: PlanNode[];
  }

  it('list / board / calendar view queries stay fast without a new index', async () => {
    const plans: { ms: number; nodes: string[] }[] = [];
    const q = explaining(plans);
    const filters: [string, FilterRoot, ViewConfig['sorts']][] = [
      ['default table (newest first, limit 500)', { op: 'and', rules: [] }, []],
      ['board (priority order)', { op: 'and', rules: [] }, [{ prop: 'priority', dir: 'asc' }]],
      ['publish within 7 days', { op: 'and', rules: [{ prop: 'publish_planned', op: 'within_next_days', value: 7 }] }, [{ prop: 'publish_planned', dir: 'asc' }]],
      ['overdue, not done, by stage', { op: 'and', rules: [{ prop: 'overdue', op: 'is', value: true }] }, [{ prop: 'stage', dir: 'asc' }]],
      ['product contains + (brand or high)', { op: 'and', rules: [{ prop: 'product', op: 'contains', value: '12' }, { op: 'or', rules: [{ prop: 'priority', op: 'is', value: 'high' }, { prop: 'channel', op: 'contains', value: 'youtube' }] }] }, [{ prop: 'product', dir: 'asc' }]],
    ];
    for (const [, filter, sorts] of filters) await listReviewsForView(q, { filter, sorts }, { today });
    await listCalendarChips(q, { from: today.slice(0, 8) + '01', to: '2100-01-01', fields: CALENDAR_FIELDS, filter: { op: 'and', rules: [{ prop: 'priority', op: 'is', value: 'high' }] } }, today);
    await listViews(q);
    const labels = [...filters.map((f) => f[0]), 'calendar month, filtered', 'tab list'];
    plans.forEach((p, i) => console.log(`[plan] ${labels[i]}: ${p.ms.toFixed(2)} ms · ${p.nodes.join(' > ')}`));
    expect(plans).toHaveLength(labels.length);
    for (const p of plans) expect(p.ms).toBeLessThan(150);
  });
});
