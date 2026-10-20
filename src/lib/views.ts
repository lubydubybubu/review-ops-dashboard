import { z } from 'zod';
import { addDays, type IsoDate } from './domain/dates';
import { CALENDAR_FIELDS, CATEGORY_KEYS, CHANNELS, PRIORITIES, SOURCE_TYPES } from './domain/review';
import { reviewFilterParams, type ReviewFilterParams } from './review-filter';
import { isoDate } from './validation';
import {
  CONNECTIVES,
  CONTAINS_OPS,
  DATE_CMP_OPS,
  DATE_PROPS,
  DATE_WITHIN_OPS,
  EMPTY_OPS,
  EQ_OPS,
  GROUP_PROPS,
  hasControlChar,
  LAYOUTS,
  LEGACY_LIST_PARAMS,
  MAX_RULES,
  MAX_SORTS,
  normalizeConfig,
  PROPERTY_KEYS,
  SORT_PROPS,
  TEXT_PROPS,
  VIEW_DATE_MAX,
  VIEW_DATE_MIN,
  VIEW_NAME_MAX,
  type DateProp,
  type Layout,
} from './view-config';

/*
 * Saved views: the one definition of what a view config may contain (zod), plus parsing of stored /
 * URL configs and the old table links. Server-side: pages, actions and the SQL compiler
 * (src/server/db/view-sql.ts, which compiles from closed maps, so every name here is a key, never a
 * column). Client components import ./view-config instead, which this module re-exports.
 *
 * Executability rules (a config this schema accepts always runs on PostgreSQL):
 *   - dates are real calendar days within VIEW_DATE_MIN … VIEW_DATE_MAX (1900-01-01 … 2999-12-31);
 *   - text values hold no C0 control character (PostgreSQL text cannot store NUL; none belong in a
 *     one-line value), the same for view names.
 */

export * from './view-config';

const id = z.number().int().positive().max(2_147_483_647);
/** A calendar day inside the supported range. */
export const viewDate = isoDate.refine(
  (d) => d >= VIEW_DATE_MIN && d <= VIEW_DATE_MAX,
  `${VIEW_DATE_MIN.slice(0, 4)}년부터 ${VIEW_DATE_MAX.slice(0, 4)}년까지의 날짜만 쓸 수 있습니다.`,
);
/** One-line text: no control characters. */
export const lineText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !hasControlChar(s), '제어 문자는 쓸 수 없습니다.');
/** `today` is resolved to the KST day when the filter runs. */
const dateValue = z.union([z.literal('today'), viewDate]);

// One strict object per (property kind × operator kind): an unknown property, operator or extra key fails.
const ruleSchemas = [
  z.strictObject({ prop: z.enum(['stage', 'brand']), op: z.enum(EQ_OPS), value: id }),
  z.strictObject({ prop: z.literal('stage_category'), op: z.enum(EQ_OPS), value: z.enum(CATEGORY_KEYS) }),
  z.strictObject({ prop: z.literal('source_type'), op: z.enum(EQ_OPS), value: z.enum(SOURCE_TYPES) }),
  z.strictObject({ prop: z.literal('priority'), op: z.enum(EQ_OPS), value: z.enum(PRIORITIES) }),
  z.strictObject({ prop: z.literal('channel'), op: z.enum(CONTAINS_OPS), value: z.enum(CHANNELS) }),
  z.strictObject({
    prop: z.enum(['brand', 'source_type', 'channel', 'title', ...DATE_PROPS]),
    op: z.enum(EMPTY_OPS),
  }),
  z.strictObject({ prop: z.literal('overdue'), op: z.literal('is'), value: z.boolean() }),
  z.strictObject({ prop: z.enum(DATE_PROPS), op: z.enum(DATE_CMP_OPS), value: dateValue }),
  z.strictObject({ prop: z.enum(DATE_PROPS), op: z.enum(DATE_WITHIN_OPS), value: z.number().int().min(0).max(365) }),
  z.strictObject({ prop: z.enum(TEXT_PROPS), op: z.enum(CONTAINS_OPS), value: lineText(100) }),
] as const;

export const filterRuleSchema = z.union(ruleSchemas);
export type FilterRule = z.infer<typeof filterRuleSchema>;

/** A nested group holds conditions only (one nesting level, as in R2.2). */
export const filterGroupSchema = z.strictObject({
  op: z.enum(CONNECTIVES),
  rules: z.array(filterRuleSchema).max(MAX_RULES),
});
export type FilterGroup = z.infer<typeof filterGroupSchema>;

export const filterRootSchema = z.strictObject({
  op: z.enum(CONNECTIVES),
  rules: z.array(z.union([filterRuleSchema, filterGroupSchema])).max(MAX_RULES),
});
export type FilterRoot = z.infer<typeof filterRootSchema>;
export type FilterNode = FilterRoot['rules'][number];

// ---------------------------------------------------------------- the config

export const viewConfigSchema = z.strictObject({
  v: z.literal(1),
  filter: filterRootSchema,
  sorts: z
    .array(z.strictObject({ prop: z.enum(SORT_PROPS), dir: z.enum(['asc', 'desc']) }))
    .max(MAX_SORTS)
    .refine((s) => new Set(s.map((x) => x.prop)).size === s.length, '같은 속성으로 두 번 정렬할 수 없습니다.'),
  groupBy: z.enum(GROUP_PROPS).nullable(),
  hidden: z.array(z.enum(PROPERTY_KEYS)).max(PROPERTY_KEYS.length),
  calendarFields: z.array(z.enum(CALENDAR_FIELDS)).max(CALENDAR_FIELDS.length),
});
export type ViewConfig = z.infer<typeof viewConfigSchema>;
export type SortSpec = ViewConfig['sorts'][number];

// ---------------------------------------------------------------- action inputs

const viewId = z.number().int().positive();
const viewName = z
  .string('보기 이름을 입력해 주세요.')
  .trim()
  .min(1, '보기 이름을 입력해 주세요.')
  .max(VIEW_NAME_MAX, `${VIEW_NAME_MAX}자 이하로 입력해 주세요.`)
  .refine((s) => !hasControlChar(s), '제어 문자는 쓸 수 없습니다.');

/** A new view; `config` = "새 보기로 저장" (the current unsaved settings), otherwise the layout default. */
export const viewCreateSchema = z.object({ layout: z.enum(LAYOUTS), name: viewName, config: viewConfigSchema.optional() });
export const viewRenameSchema = z.object({ id: viewId, name: viewName });
export const viewIdSchema = z.object({ id: viewId });
export const viewMoveSchema = z.object({ id: viewId, direction: z.enum(['left', 'right']) });
export const viewSaveSchema = z.object({ id: viewId, expectedVersion: z.number().int().min(1), config: viewConfigSchema });

/** Parse a stored or URL-supplied config; `null` when it is not a valid config (callers fall back). */
export function parseConfig(layout: Layout, raw: unknown): ViewConfig | null {
  const parsed = viewConfigSchema.safeParse(raw);
  return parsed.success ? normalizeConfig(layout, parsed.data) : null;
}

export function parseDraftParam(layout: Layout, value: string): ViewConfig | null {
  if (value.length > 8_000) return null;
  try {
    return parseConfig(layout, JSON.parse(value));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- date semantics

/**
 * The inclusive KST day range of "within the next / past N days" (N ≤ 365, counted from the Seoul
 * day): on 10-21 "within the next 3 days" is 10-21 … 10-24. The fixed-date comparisons (on / before /
 * after / on or …) need no arithmetic: the compiler compares against the validated date directly.
 */
export function dateRuleRange(op: (typeof DATE_WITHIN_OPS)[number], days: number, today: IsoDate): { from: IsoDate; to: IsoDate } {
  return op === 'within_next_days' ? { from: today, to: addDays(today, days) } : { from: addDays(today, -days), to: today };
}

// ---------------------------------------------------------------- old table links

/**
 * Old table links (dashboard stage counts, brand review counts, bookmarks) open the default table
 * view with those filters applied as unsaved edits. Returns null when the URL has none of them (or
 * when the result is not a valid config: it goes through the same schema as every other draft).
 */
export function legacyListDraft(saved: ViewConfig, raw: Record<string, string | undefined>): ViewConfig | null {
  if (!LEGACY_LIST_PARAMS.some((k) => raw[k])) return null;
  const p: ReviewFilterParams = reviewFilterParams.parse(raw);
  const rules: FilterNode[] = [];
  if (p.q) {
    rules.push({
      op: 'or',
      rules: [
        { prop: 'product', op: 'contains', value: p.q },
        { prop: 'title', op: 'contains', value: p.q },
      ],
    });
  }
  if (p.stage) rules.push({ prop: 'stage', op: 'is', value: p.stage });
  if (p.category) rules.push({ prop: 'stage_category', op: 'is', value: p.category });
  if (p.brand) rules.push({ prop: 'brand', op: 'is', value: p.brand });
  const field: DateProp = p.field ?? 'publish_planned';
  if (p.from) rules.push({ prop: field, op: 'on_or_after', value: p.from });
  if (p.to) rules.push({ prop: field, op: 'on_or_before', value: p.to });
  // The link's conditions narrow an AND view; an OR view is replaced by them (they are the link's intent).
  const filter: FilterRoot =
    rules.length === 0
      ? saved.filter
      : { op: 'and', rules: (saved.filter.op === 'and' ? [...saved.filter.rules, ...rules] : rules).slice(0, MAX_RULES) };
  const sorts: SortSpec[] = p.sort ? [{ prop: p.sort, dir: p.dir ?? 'asc' }] : saved.sorts;
  return parseConfig('list', { ...saved, filter, sorts });
}
