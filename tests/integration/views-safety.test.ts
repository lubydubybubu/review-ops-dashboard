import type pg from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayInSeoul } from '../../src/lib/domain/dates';
import { CALENDAR_FIELDS } from '../../src/lib/domain/review';
import { defaultConfig, serializeConfig, viewSaveSchema, type FilterRule, type ViewConfig } from '../../src/lib/views';
import { listCalendarChips } from '../../src/server/db/calendar';
import { listReviewsForView } from '../../src/server/db/reviews';
import { seedDemo } from '../../src/server/db/seed';
import { listViews } from '../../src/server/db/views';
import { resolveViewFrom, runViewQuery, type ResolvedView } from '../../src/server/view-resolve';
import { resetData, useAdminPool, useAppPool } from './helpers';

/*
 * Regression tests for the saved-views review (independent review R2): every config the shared schema accepts must
 * run on PostgreSQL, through the same resolver the pages use; anything that still cannot run falls back
 * to a working query with the inline notice instead of failing the page.
 */

const DRAFT_NOTICE = /주소에 담긴 보기 설정이 올바르지 않아/;
const STORED_NOTICE = /저장된 보기 설정을 읽지 못해 기본 설정/;
const SEEDED = [
  { layout: 'list', name: '전체 리뷰' },
  { layout: 'board', name: '진행 보드' },
  { layout: 'calendar', name: '캘린더' },
] as const;

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

const withRule = (rule: FilterRule, layout: 'list' | 'board' = 'list'): ViewConfig => ({
  ...defaultConfig(layout),
  filter: { op: 'and', rules: [rule] },
});

function resolved(outcome: ReturnType<typeof resolveViewFrom>): ResolvedView {
  if ('redirect' in outcome) throw new Error(`unexpected redirect ${outcome.redirect}`);
  return outcome;
}

describe('saved views: accepted configs always execute (R2 regression)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  const today = todayInSeoul();

  beforeAll(async () => {
    await resetData(admin);
    await seedDemo(db, today);
  });
  beforeEach(() => resetViews(admin));
  afterEach(() => vi.restoreAllMocks());

  const listView = async () => (await listViews(db)).find((v) => v.layout === 'list')!;
  const page = async (search: Record<string, string>) => resolved(resolveViewFrom(await listViews(db), 'list', search));
  const rows = (r: ResolvedView) => runViewQuery(r, (config) => listReviewsForView(db, config, { today }));

  it('a URL draft with NUL (or another control character) in a text value falls back with the notice; the page query runs', async () => {
    const list = await listView();
    for (const value of ['\u0000', 'Kes\u0000trel', '\u001f', 'a\tb', 'a\nb']) {
      const r = await page({ v: String(list.id), cfg: serializeConfig(withRule({ prop: 'product', op: 'contains', value })) });
      expect(r.notices.join(), JSON.stringify(value)).toMatch(DRAFT_NOTICE);
      expect(r.effective).toEqual(defaultConfig('list'));
      await expect(rows(r)).resolves.toMatchObject({ result: expect.any(Array) });
    }
    // ordinary text is untouched
    const ok = await page({ v: String(list.id), cfg: serializeConfig(withRule({ prop: 'product', op: 'contains', value: 'Kestrel' })) });
    expect(ok.notices).toEqual([]);
    expect((await rows(ok)).result.length).toBeGreaterThan(0);
  });

  it('a legacy ?q= link with NUL is dropped, not run', async () => {
    const r = await page({ q: 'x\u0000' });
    expect(r.effective).toEqual(defaultConfig('list'));
    await expect(rows(r)).resolves.toMatchObject({ result: expect.any(Array) });
  });

  it('boundary dates 1900-01-01 / 2999-12-31 with every comparison run on PG (list and calendar); beyond the range falls back', async () => {
    const list = await listView();
    for (const op of ['on', 'before', 'after', 'on_or_before', 'on_or_after'] as const) {
      for (const value of ['1900-01-01', '2999-12-31']) {
        const rule = { prop: 'shoot', op, value } as FilterRule;
        const r = await page({ v: String(list.id), cfg: serializeConfig(withRule(rule)) });
        expect(r.notices, `${op} ${value}`).toEqual([]);
        expect(r.effective.filter.rules).toEqual([rule]);
        await expect(rows(r), `${op} ${value}`).resolves.toMatchObject({ result: expect.any(Array) });
        await expect(
          listCalendarChips(db, { from: '2026-10-01', to: '2026-11-01', fields: CALENDAR_FIELDS, filter: r.effective.filter }, today),
        ).resolves.toBeInstanceOf(Array);
      }
      for (const value of ['9999-12-31', '3000-01-01', '1899-12-31']) {
        const r = await page({ v: String(list.id), cfg: serializeConfig(withRule({ prop: 'shoot', op, value } as FilterRule)) });
        expect(r.notices.join(), `${op} ${value}`).toMatch(DRAFT_NOTICE);
        await expect(rows(r)).resolves.toMatchObject({ result: expect.any(Array) });
      }
    }
  });

  it('the save / chips action schema refuses the same values (one shared validator)', () => {
    const list = { id: 1, expectedVersion: 1 };
    for (const rule of [
      { prop: 'shoot', op: 'after', value: '9999-12-31' },
      { prop: 'embargo', op: 'before', value: '1899-12-31' },
      { prop: 'product', op: 'contains', value: '\u0000' },
      { prop: 'title', op: 'not_contains', value: 'x\u0007' },
    ] as FilterRule[]) {
      expect(viewSaveSchema.safeParse({ ...list, config: withRule(rule) }).success, JSON.stringify(rule)).toBe(false);
    }
    expect(viewSaveSchema.safeParse({ ...list, config: withRule({ prop: 'shoot', op: 'after', value: '2999-12-31' }) }).success).toBe(true);
  });

  it('a stored config with an out-of-range date (saved before this fix) opens the default with the notice and runs', async () => {
    const list = await listView();
    await admin.query('update saved_views set config = $2 where id = $1', [list.id, withRule({ prop: 'shoot', op: 'after', value: '9999-12-31' })]);
    const r = await page({});
    expect(r.view?.id).toBe(list.id);
    expect(r.notices.join()).toMatch(STORED_NOTICE);
    expect(r.effective).toEqual(defaultConfig('list'));
    await expect(rows(r)).resolves.toMatchObject({ result: expect.any(Array) });
    // board too (same resolver, same query)
    const board = (await listViews(db)).find((v) => v.layout === 'board')!;
    await admin.query('update saved_views set config = $2 where id = $1', [board.id, withRule({ prop: 'write_due', op: 'before', value: '0999-01-01' }, 'board')]);
    const b = resolved(resolveViewFrom(await listViews(db), 'board', {}));
    expect(b.notices.join()).toMatch(STORED_NOTICE);
    await expect(runViewQuery(b, (config) => listReviewsForView(db, config, { today }))).resolves.toMatchObject({ result: expect.any(Array) });
  });

  it('a config that still fails on PG falls back (draft → saved → default) with the notice; only a fixed tag is logged', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = await page({});
    // bypass the schema on purpose: this is the "accepted earlier, cannot run now" case
    const poison = withRule({ prop: 'product', op: 'contains', value: 'x\u0000y' });

    const draft = await rows({ ...base, effective: poison });
    expect(draft.resolved.effective).toEqual(base.saved);
    expect(draft.resolved.notices.join()).toMatch(DRAFT_NOTICE);
    expect(draft.result.length).toBeGreaterThan(0);

    const stored = await rows({ ...base, saved: poison, effective: poison });
    expect(stored.resolved.saved).toEqual(defaultConfig('list'));
    expect(stored.resolved.effective).toEqual(defaultConfig('list'));
    expect(stored.resolved.notices.join()).toMatch(STORED_NOTICE);
    expect(stored.result.length).toBeGreaterThan(0);

    const lines = logged.mock.calls.map((args) => args.map(String).join(' '));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^views: fallback reason=[a-z-]+$/);

    // an unrelated failure (DB down etc.) is not hidden behind a fallback
    await expect(runViewQuery(base, () => Promise.reject(new Error('connection terminated')))).rejects.toThrow('connection terminated');
  });
});
