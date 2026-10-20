import { describe, expect, it } from 'vitest';
import { todayInSeoul } from '../../src/lib/domain/dates';
import {
  countRules,
  dateRuleRange,
  defaultConfig,
  defaultRule,
  FILTER_PROPS,
  hasControlChar,
  LAYOUTS,
  legacyListDraft,
  normalizeConfig,
  OPS_FOR,
  parseConfig,
  parseDraftParam,
  sameConfig,
  serializeConfig,
  VIEW_DATE_MAX,
  VIEW_DATE_MIN,
  viewConfigSchema,
  viewCreateSchema,
  viewHref,
  viewRenameSchema,
  viewSaveSchema,
  type FilterRoot,
  type FilterRule,
  type ViewConfig,
} from '../../src/lib/views';
import { compileFilter, compileOrder, sqlParams, ViewSqlError } from '../../src/server/db/view-sql';

const TODAY = '2026-10-20';
const ctx = { stages: [{ id: 3 }], brands: [{ id: 9 }] };

function compile(filter: FilterRoot, today = TODAY) {
  const { values, param } = sqlParams();
  return { sql: compileFilter(filter, { param, today }), values };
}
const one = (rule: FilterRule) => compile({ op: 'and', rules: [rule] });
const config = (patch: Partial<ViewConfig> = {}): ViewConfig => ({ ...defaultConfig('list'), ...patch });

describe('view config schema', () => {
  it('accepts the default config of every layout', () => {
    for (const layout of LAYOUTS) expect(viewConfigSchema.safeParse(defaultConfig(layout)).success).toBe(true);
  });

  it('accepts every property × operator the editor can produce', () => {
    let n = 0;
    for (const prop of FILTER_PROPS) {
      for (const op of OPS_FOR[prop]) {
        const rule = defaultRule(prop, ctx, op);
        expect(viewConfigSchema.safeParse(config({ filter: { op: 'and', rules: [rule] } })).success, `${prop} ${op}`).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(60);
  });

  it.each([
    ['unknown property', { prop: 'notes_md', op: 'contains', value: 'x' }],
    ['column-shaped property', { prop: 'r.id; drop table reviews', op: 'is', value: 1 }],
    ['operator not allowed for the property', { prop: 'priority', op: 'contains', value: 'high' }],
    ['wrong value type', { prop: 'stage', op: 'is', value: '3 or 1=1' }],
    ['unknown enum value', { prop: 'stage_category', op: 'is', value: 'archived' }],
    ['bad date', { prop: 'shoot', op: 'before', value: '2026-02-30' }],
    ['sql in a date', { prop: 'shoot', op: 'before', value: "2026-10-20'::date or true --" }],
    ['days out of range', { prop: 'shoot', op: 'within_next_days', value: 400 }],
    ['value on an empty-check', { prop: 'brand', op: 'is_empty', value: 1 }],
    ['extra key', { prop: 'priority', op: 'is', value: 'high', sql: 'true' }],
    ['product is never empty', { prop: 'product', op: 'is_empty' }],
  ])('rejects a rule with %s', (_label, rule) => {
    expect(viewConfigSchema.safeParse(config({ filter: { op: 'and', rules: [rule as FilterRule] } })).success).toBe(false);
  });

  it('allows one nesting level only, and only and/or', () => {
    const rule = defaultRule('priority', ctx);
    expect(viewConfigSchema.safeParse(config({ filter: { op: 'or', rules: [{ op: 'and', rules: [rule] }] } })).success).toBe(true);
    const deep = { op: 'or', rules: [{ op: 'and', rules: [{ op: 'or', rules: [rule] }] }] };
    expect(viewConfigSchema.safeParse(config({ filter: deep as unknown as FilterRoot })).success).toBe(false);
    expect(viewConfigSchema.safeParse(config({ filter: { op: 'xor', rules: [] } as unknown as FilterRoot })).success).toBe(false);
  });

  it('rejects duplicate sorts, too many sorts, unknown sort / group / property keys', () => {
    expect(viewConfigSchema.safeParse(config({ sorts: [{ prop: 'shoot', dir: 'asc' }, { prop: 'shoot', dir: 'desc' }] })).success).toBe(false);
    const six = (['product', 'brand', 'stage', 'priority', 'shoot', 'embargo'] as const).map((prop) => ({ prop, dir: 'asc' as const }));
    expect(viewConfigSchema.safeParse(config({ sorts: six })).success).toBe(false);
    expect(viewConfigSchema.safeParse({ ...config(), sorts: [{ prop: 'notes_md', dir: 'asc' }] }).success).toBe(false);
    expect(viewConfigSchema.safeParse({ ...config(), groupBy: 'title' }).success).toBe(false);
    expect(viewConfigSchema.safeParse({ ...config(), hidden: ['product'] }).success).toBe(false);
    expect(viewConfigSchema.safeParse({ ...config(), v: 2 }).success).toBe(false);
  });

  it('normalizes per layout and makes equal configs serialize equally', () => {
    const board = normalizeConfig('board', config({ groupBy: null, calendarFields: ['shoot'] }));
    expect([board.groupBy, board.calendarFields]).toEqual(['stage', []]);
    const cal = normalizeConfig('calendar', config({ sorts: [{ prop: 'shoot', dir: 'asc' }], groupBy: 'brand', calendarFields: ['embargo', 'shoot'] }));
    expect([cal.sorts, cal.groupBy, cal.calendarFields]).toEqual([[], null, ['shoot', 'embargo']]);
    const a = parseConfig('list', { ...config(), hidden: ['channels', 'embargo'] })!;
    const b = parseConfig('list', JSON.parse(JSON.stringify({ calendarFields: [], hidden: ['embargo', 'channels'], groupBy: null, sorts: [], filter: { rules: [], op: 'and' }, v: 1 })))!;
    expect(sameConfig(a, b)).toBe(true);
  });

  it('parses a draft URL parameter or returns null (never throws)', () => {
    const c = config({ groupBy: 'brand' });
    expect(parseDraftParam('list', serializeConfig(c))).toEqual(c);
    for (const bad of ['{', 'null', '[]', '{"v":1}', 'x'.repeat(9000)]) expect(parseDraftParam('list', bad)).toBeNull();
    expect(parseConfig('board', { garbage: true })).toBeNull();
  });

  it('save input wraps the config schema', () => {
    expect(viewSaveSchema.safeParse({ id: 1, expectedVersion: 1, config: config() }).success).toBe(true);
    expect(viewSaveSchema.safeParse({ id: 1, expectedVersion: 0, config: config() }).success).toBe(false);
    expect(viewSaveSchema.safeParse({ id: 1, expectedVersion: 1, config: { ...config(), filter: { op: 'and', rules: [{ prop: 'x' }] } } }).success).toBe(false);
  });

  it('builds view URLs and counts conditions', () => {
    expect(viewHref('board', 4, null)).toBe('/board?v=4');
    expect(viewHref('calendar', null, null, { date: '2026-10-20' })).toBe('/calendar?date=2026-10-20');
    expect(decodeURIComponent(viewHref('list', 1, config()))).toContain('cfg={"v":1');
    expect(countRules({ op: 'and', rules: [defaultRule('priority', ctx), { op: 'or', rules: [defaultRule('brand', ctx), defaultRule('overdue', ctx)] }] })).toBe(3);
  });

  it('turns the old table query parameters into unsaved edits of the default view', () => {
    const saved = defaultConfig('list');
    expect(legacyListDraft(saved, {})).toBeNull();
    const draft = legacyListDraft(saved, { stage: '3', brand: '2', q: 'mic', field: 'shoot', from: '2026-10-01', to: '2026-10-31', sort: 'shoot', dir: 'desc' })!;
    expect(draft.filter).toEqual({
      op: 'and',
      rules: [
        { op: 'or', rules: [{ prop: 'product', op: 'contains', value: 'mic' }, { prop: 'title', op: 'contains', value: 'mic' }] },
        { prop: 'stage', op: 'is', value: 3 },
        { prop: 'brand', op: 'is', value: 2 },
        { prop: 'shoot', op: 'on_or_after', value: '2026-10-01' },
        { prop: 'shoot', op: 'on_or_before', value: '2026-10-31' },
      ],
    });
    expect(draft.sorts).toEqual([{ prop: 'shoot', dir: 'desc' }]);
    expect(viewConfigSchema.safeParse(draft).success).toBe(true);
    // invalid legacy values are dropped, not errors
    expect(legacyListDraft(saved, { stage: 'abc', category: 'nope' })!.filter.rules).toEqual([]);
  });
});

describe('filter → SQL compiler', () => {
  it('compiles every operator of every property to parameterized SQL (no value inlined)', () => {
    for (const prop of FILTER_PROPS) {
      for (const op of OPS_FOR[prop]) {
        const rule = defaultRule(prop, ctx, op);
        const { sql, values } = one(rule);
        // the only string literals are constants: the overdue rule's 'done' and coalesce(…, '')
        expect(sql.replaceAll("'done'", '').replaceAll("''", ''), `${prop} ${op}`).not.toContain("'");
        if ('value' in rule && typeof rule.value !== 'boolean') expect(values.length, `${prop} ${op}`).toBeGreaterThan(0);
        for (const v of values) expect(sql).not.toContain(String(v));
      }
    }
  });

  it.each<[string, FilterRule, string, unknown[]]>([
    ['stage is', { prop: 'stage', op: 'is', value: 3 }, 'r.stage_id = $1::bigint', [3]],
    ['stage is not', { prop: 'stage', op: 'is_not', value: 3 }, 'r.stage_id is distinct from $1::bigint', [3]],
    ['category is', { prop: 'stage_category', op: 'is', value: 'done' }, 's.category_key = $1::text', ['done']],
    ['brand is empty', { prop: 'brand', op: 'is_empty' }, 'r.brand_id is null', []],
    ['source not empty', { prop: 'source_type', op: 'is_not_empty' }, 'r.source_type is not null', []],
    ['priority is not', { prop: 'priority', op: 'is_not', value: 'low' }, 'r.priority is distinct from $1::text', ['low']],
    ['channel contains', { prop: 'channel', op: 'contains', value: 'blog' }, '$1::text = any(r.channels)', ['blog']],
    ['channel not contains', { prop: 'channel', op: 'not_contains', value: 'blog' }, 'not ($1::text = any(r.channels))', ['blog']],
    ['channel empty', { prop: 'channel', op: 'is_empty' }, '(cardinality(r.channels) = 0)', []],
    ['title contains', { prop: 'title', op: 'contains', value: '50%_off' }, 'r.title ilike $1', ['%50\\%\\_off%']],
    ['title not contains', { prop: 'title', op: 'not_contains', value: 'a' }, "coalesce(r.title, '') not ilike $1", ['%a%']],
    ['title empty', { prop: 'title', op: 'is_empty' }, 'r.title is null', []],
    ['on', { prop: 'shoot', op: 'on', value: '2026-11-03' }, 'r.shoot_on = $1::date', ['2026-11-03']],
    ['before today', { prop: 'write_due', op: 'before', value: 'today' }, 'r.write_due_on < $1::date', [TODAY]],
    ['after', { prop: 'embargo', op: 'after', value: '2026-12-31' }, 'r.embargo_until > $1::date', ['2026-12-31']],
    ['after the last supported day', { prop: 'embargo', op: 'after', value: '2999-12-31' }, 'r.embargo_until > $1::date', ['2999-12-31']],
    ['before the first supported day', { prop: 'shoot', op: 'before', value: '1900-01-01' }, 'r.shoot_on < $1::date', ['1900-01-01']],
    ['on or before', { prop: 'received', op: 'on_or_before', value: '2026-10-01' }, 'r.received_on <= $1::date', ['2026-10-01']],
    ['on or after', { prop: 'publish_planned', op: 'on_or_after', value: 'today' }, 'r.publish_planned_on >= $1::date', [TODAY]],
    ['within next', { prop: 'publish_planned', op: 'within_next_days', value: 7 }, '(r.publish_planned_on >= $1::date and r.publish_planned_on <= $2::date)', [TODAY, '2026-10-27']],
    ['within past', { prop: 'shoot', op: 'within_past_days', value: 0 }, '(r.shoot_on >= $1::date and r.shoot_on <= $2::date)', [TODAY, TODAY]],
    ['date empty', { prop: 'embargo', op: 'is_empty' }, 'r.embargo_until is null', []],
  ])('%s', (_label, rule, sql, values) => {
    expect(one(rule)).toEqual({ sql, values });
  });

  it('overdue mirrors the overdue rule with today as a parameter', () => {
    const yes = one({ prop: 'overdue', op: 'is', value: true });
    expect(yes.sql).toBe("coalesce(s.category_key <> 'done' and (r.write_due_on < $1::date or r.publish_planned_on < $1::date), false)");
    expect(yes.values).toEqual([TODAY]);
    expect(one({ prop: 'overdue', op: 'is', value: false }).sql).toMatch(/^not coalesce\(/);
  });

  it('joins AND / OR with one nesting level, numbering parameters in order', () => {
    const filter: FilterRoot = {
      op: 'and',
      rules: [
        { prop: 'stage_category', op: 'is_not', value: 'done' },
        { op: 'or', rules: [{ prop: 'brand', op: 'is', value: 2 }, { prop: 'priority', op: 'is', value: 'high' }] },
      ],
    };
    expect(compile(filter)).toEqual({
      sql: '((s.category_key is distinct from $1::text) and (((r.brand_id = $2::bigint) or (r.priority = $3::text))))',
      values: ['done', 2, 'high'],
    });
    expect(compile({ op: 'or', rules: [] }).sql).toBe('true');
    expect(compile({ op: 'and', rules: [{ op: 'or', rules: [] }] }).sql).toBe('true');
  });

  it('continues numbering after existing parameters (calendar query)', () => {
    const { values, param } = sqlParams(3);
    expect(compileFilter({ op: 'and', rules: [{ prop: 'priority', op: 'is', value: 'high' }] }, { param, today: TODAY })).toBe('r.priority = $4::text');
    expect(values).toEqual(['high']);
  });

  it('keeps injection-shaped values as bind parameters', () => {
    const evil = "x'; drop table reviews; --";
    const { sql, values } = compile({
      op: 'or',
      rules: [
        { prop: 'product', op: 'contains', value: evil },
        { prop: 'title', op: 'not_contains', value: "') or true --" },
      ],
    });
    expect(sql).toBe("((r.product_name ilike $1) or (coalesce(r.title, '') not ilike $2))");
    expect(values).toEqual([`%${evil}%`, "%') or true --%"]);
  });

  it('refuses anything outside the closed maps even when the schema is bypassed', () => {
    const bad = (rule: unknown) => () => one(rule as FilterRule);
    expect(bad({ prop: 'r.id) or (true', op: 'is', value: 1 })).toThrow(ViewSqlError);
    expect(bad({ prop: 'constructor', op: 'is', value: 1 })).toThrow(ViewSqlError);
    expect(bad({ prop: '__proto__', op: 'is_empty' })).toThrow(ViewSqlError);
    expect(bad({ prop: 'priority', op: 'like', value: 'x' })).toThrow(ViewSqlError);
    expect(bad({ prop: 'shoot', op: 'contains', value: 'x' })).toThrow(ViewSqlError);
    expect(bad({ prop: 'overdue', op: 'is', value: 'true' })).toThrow(ViewSqlError);
    expect(bad({ prop: 'stage', op: 'is', value: { toString: () => '1' } })).toThrow(ViewSqlError);
    const deep = { op: 'and', rules: [{ op: 'or', rules: [{ op: 'and', rules: [] }] }] };
    expect(() => compile(deep as unknown as FilterRoot)).toThrow(ViewSqlError);
    expect(() => compile({ op: 'xor', rules: [] } as unknown as FilterRoot)).toThrow(ViewSqlError);
  });

  it('compiles ordered multi-sorts from the closed map', () => {
    expect(compileOrder([])).toBe('r.updated_at desc, r.id desc');
    expect(compileOrder([{ prop: 'stage', dir: 'desc' }, { prop: 'publish_planned', dir: 'asc' }])).toBe(
      'c.sort desc nulls last, s.sort desc nulls last, r.publish_planned_on asc nulls last, r.id',
    );
    expect(() => compileOrder([{ prop: 'r.id; drop', dir: 'asc' } as never])).toThrow(ViewSqlError);
    expect(() => compileOrder([{ prop: 'shoot', dir: 'asc; drop' } as never])).toThrow(ViewSqlError);
  });
});

describe('KST date semantics', () => {
  it('"today" is the Seoul day: 23:59 KST is still the same day, 00:00 KST the next', () => {
    expect(todayInSeoul(new Date('2026-10-20T14:59:59Z'))).toBe('2026-10-20');
    expect(todayInSeoul(new Date('2026-10-20T15:00:00Z'))).toBe('2026-10-21');
  });

  it('within N days counts from the KST day, inclusive at both ends', () => {
    const lateUtc = todayInSeoul(new Date('2026-10-20T15:30:00Z')); // 00:30 KST on 10-21
    expect(dateRuleRange('within_next_days', 3, lateUtc)).toEqual({ from: '2026-10-21', to: '2026-10-24' });
    expect(dateRuleRange('within_past_days', 3, lateUtc)).toEqual({ from: '2026-10-18', to: '2026-10-21' });
    expect(dateRuleRange('within_next_days', 0, lateUtc)).toEqual({ from: '2026-10-21', to: '2026-10-21' });
    // across a month and a year end
    expect(dateRuleRange('within_next_days', 7, '2026-12-28')).toEqual({ from: '2026-12-28', to: '2027-01-04' });
    // compiled: the bounds are KST dates passed as parameters
    expect(compile({ op: 'and', rules: [{ prop: 'shoot', op: 'within_next_days', value: 3 }] }, lateUtc).values).toEqual(['2026-10-21', '2026-10-24']);
  });

  it('before / after are exclusive, on-or-… inclusive: one direct comparison, no day arithmetic', () => {
    const sql = (op: 'before' | 'after' | 'on_or_before' | 'on_or_after' | 'on', value = 'today') =>
      one({ prop: 'shoot', op, value });
    expect(sql('before', '2026-03-01')).toEqual({ sql: 'r.shoot_on < $1::date', values: ['2026-03-01'] });
    expect(sql('after')).toEqual({ sql: 'r.shoot_on > $1::date', values: [TODAY] });
    expect(sql('on_or_before')).toEqual({ sql: 'r.shoot_on <= $1::date', values: [TODAY] });
    expect(sql('on_or_after')).toEqual({ sql: 'r.shoot_on >= $1::date', values: [TODAY] });
    expect(sql('on')).toEqual({ sql: 'r.shoot_on = $1::date', values: [TODAY] });
  });
});

describe('executable configs only (independent review R2)', () => {
  const rule = (r: unknown) => viewConfigSchema.safeParse(config({ filter: { op: 'and', rules: [r as FilterRule] } })).success;

  it('dates: 1900-01-01 … 2999-12-31 inclusive, for every comparison', () => {
    expect([VIEW_DATE_MIN, VIEW_DATE_MAX]).toEqual(['1900-01-01', '2999-12-31']);
    for (const op of ['on', 'before', 'after', 'on_or_before', 'on_or_after']) {
      for (const value of ['1900-01-01', '2999-12-31', 'today', '2026-02-28']) expect(rule({ prop: 'shoot', op, value }), `${op} ${value}`).toBe(true);
      for (const value of ['1899-12-31', '3000-01-01', '9999-12-31', '0999-01-01']) expect(rule({ prop: 'shoot', op, value }), `${op} ${value}`).toBe(false);
    }
  });

  it('text values and view names: no C0 control characters', () => {
    for (const value of ['\u0000', 'a\u0000b', '\u0007', '\u001f', 'a\tb', 'a\nb', 'a\rb']) {
      expect(rule({ prop: 'product', op: 'contains', value }), JSON.stringify(value)).toBe(false);
      expect(rule({ prop: 'title', op: 'not_contains', value }), JSON.stringify(value)).toBe(false);
      expect(viewRenameSchema.safeParse({ id: 1, name: `보기${value}이름` }).success, JSON.stringify(value)).toBe(false);
    }
    for (const value of ['', 'Kestrel 50%_off', '한글 　 전각', "x'; drop table reviews; --"]) {
      expect(rule({ prop: 'product', op: 'contains', value }), value).toBe(true);
    }
    expect([hasControlChar('ok'), hasControlChar('\u007f'), hasControlChar('\u0000')]).toEqual([false, false, true]);
  });

  it('old table links follow the same rules (a bad value is dropped, the rest of the link still applies)', () => {
    const saved = defaultConfig('list');
    expect(legacyListDraft(saved, { q: 'x\u0000', stage: '3' })!.filter.rules).toEqual([{ prop: 'stage', op: 'is', value: 3 }]);
    expect(legacyListDraft(saved, { from: '9999-01-01', to: '2026-10-31' })!.filter.rules).toEqual([
      { prop: 'publish_planned', op: 'on_or_before', value: '2026-10-31' },
    ]);
  });

  it('the compiler refuses an impossible date or day count even when the schema is bypassed', () => {
    const bad = (rule: unknown) => () => one(rule as FilterRule);
    expect(bad({ prop: 'shoot', op: 'after', value: '+010000-01-01' })).toThrow(ViewSqlError);
    expect(bad({ prop: 'shoot', op: 'on', value: 20261020 })).toThrow(ViewSqlError);
    expect(bad({ prop: 'shoot', op: 'within_next_days', value: 1e9 })).toThrow(ViewSqlError);
    expect(bad({ prop: 'shoot', op: 'within_past_days', value: '7' })).toThrow(ViewSqlError);
  });

  it('"새 보기로 저장" input: a validated config, or none (layout default)', () => {
    expect(viewCreateSchema.safeParse({ layout: 'list', name: '새 보기' }).success).toBe(true);
    expect(viewCreateSchema.safeParse({ layout: 'list', name: '새 보기', config: config({ groupBy: 'brand' }) }).success).toBe(true);
    expect(viewCreateSchema.safeParse({ layout: 'list', name: '새 보기', config: { ...config(), groupBy: 'r.body_md' } }).success).toBe(false);
  });
});

describe('draft base version in the URL (independent review R1)', () => {
  it('a draft URL carries the version it started from; no draft, no base', () => {
    const href = viewHref('list', 7, config({ groupBy: 'brand' }), {}, 3);
    const url = new URL(href, 'https://ops.test');
    expect([url.searchParams.get('v'), url.searchParams.get('base')]).toEqual(['7', '3']);
    expect(viewHref('list', 7, null, {}, 3)).toBe('/reviews?v=7');
    expect(new URL(viewHref('list', 7, config(), {}, null), 'https://ops.test').searchParams.has('base')).toBe(false);
  });
});

describe('client bundles stay free of the schema (optimization 2)', () => {
  it('no client component imports zod or the schema modules (type-only imports are erased)', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const root = path.resolve(import.meta.dirname, '../../src');
    const files = (await readdir(root, { recursive: true })).filter((f) => /\.tsx?$/.test(f));
    const offenders: string[] = [];
    let clientFiles = 0;
    for (const file of files) {
      const text = await readFile(path.join(root, file), 'utf8');
      if (!/^['"]use client['"]/.test(text)) continue;
      clientFiles++;
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)) {
        if (/^zod$|(^|\/)lib\/(views|validation|review-filter)$/.test(m[1]!)) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(clientFiles).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
