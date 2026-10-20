import { CALENDAR_FIELDS } from './domain/review';
import type { FilterGroup, FilterNode, FilterRoot, FilterRule, ViewConfig } from './views';

/*
 * Saved views ("저장된 보기"): the client-safe half — names, labels, defaults, normalization and URLs.
 * No zod here: client components import this module only. The one validator for what a config may
 * contain is the schema in ./views (server pages, actions and the SQL compiler use it); the types
 * below are inferred from that schema, so the two cannot drift.
 */

export type { FilterGroup, FilterNode, FilterRoot, FilterRule, SortSpec, ViewConfig } from './views';

export const LAYOUTS = ['list', 'board', 'calendar'] as const;
export type Layout = (typeof LAYOUTS)[number];
export const LAYOUT_LABEL: Record<Layout, string> = { list: '표', board: '보드', calendar: '캘린더' };
/** Each layout keeps its pre-views URL; `?v=<id>` picks a saved view, `?cfg=` carries unsaved edits. */
export const VIEW_PATH: Record<Layout, string> = { list: '/reviews', board: '/board', calendar: '/calendar' };
export const VIEW_PARAM = 'v';
export const DRAFT_PARAM = 'cfg';
/**
 * The saved version an unsaved draft (`?cfg=`) started from, pinned when the edit starts and sent as
 * the compare-and-set token on 저장. A draft without it (an old link, a hand-made URL) has no known
 * base and is never saved over the view without asking.
 */
export const BASE_PARAM = 'base';

export const VIEW_STALE_MESSAGE = '다른 곳에서 보기 설정이 바뀌었습니다. 새로고침 후 다시 시도하세요.';
export const VIEW_NAME_MAX = 40;

/**
 * Dates a view condition may name: 1900-01-01 … 2999-12-31 (inclusive). Comfortably wider than any
 * review date, and far inside what PostgreSQL's `date` and JavaScript's Date can represent.
 */
export const VIEW_DATE_MIN = '1900-01-01';
export const VIEW_DATE_MAX = '2999-12-31';

/** True when `s` holds a C0 control character (U+0000–U+001F). PostgreSQL text cannot store NUL. */
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true;
  return false;
}

// ---------------------------------------------------------------- filter properties

export const DATE_PROPS = ['received', 'shoot', 'write_due', 'publish_planned', 'embargo'] as const;
export type DateProp = (typeof DATE_PROPS)[number];
export const TEXT_PROPS = ['product', 'title'] as const;

export const FILTER_PROPS = [
  'stage',
  'stage_category',
  'brand',
  'source_type',
  'priority',
  'channel',
  'overdue',
  ...DATE_PROPS,
  ...TEXT_PROPS,
] as const;
export type FilterProp = (typeof FILTER_PROPS)[number];

export const FILTER_PROP_LABEL: Record<FilterProp, string> = {
  stage: '단계',
  stage_category: '단계 분류',
  brand: '브랜드',
  source_type: '입수 형태',
  priority: '우선순위',
  channel: '채널',
  overdue: '지연',
  received: '입고일',
  shoot: '촬영일',
  write_due: '작성 마감',
  publish_planned: '발행 예정',
  embargo: '엠바고',
  product: '제품명',
  title: '작업 제목',
};

export const EQ_OPS = ['is', 'is_not'] as const;
export const EMPTY_OPS = ['is_empty', 'is_not_empty'] as const;
export const DATE_CMP_OPS = ['on', 'before', 'after', 'on_or_before', 'on_or_after'] as const;
export const DATE_WITHIN_OPS = ['within_next_days', 'within_past_days'] as const;
export const CONTAINS_OPS = ['contains', 'not_contains'] as const;

export type FilterOp =
  | (typeof EQ_OPS)[number]
  | (typeof EMPTY_OPS)[number]
  | (typeof DATE_CMP_OPS)[number]
  | (typeof DATE_WITHIN_OPS)[number]
  | (typeof CONTAINS_OPS)[number];

export const FILTER_OP_LABEL: Record<FilterOp, string> = {
  is: '같음',
  is_not: '같지 않음',
  is_empty: '비어 있음',
  is_not_empty: '비어 있지 않음',
  on: '당일',
  before: '이전',
  after: '이후',
  on_or_before: '당일 또는 이전',
  on_or_after: '당일 또는 이후',
  within_next_days: '앞으로 N일 이내',
  within_past_days: '지난 N일 이내',
  contains: '포함',
  not_contains: '포함하지 않음',
};

const DATE_OPS = [...DATE_CMP_OPS, ...DATE_WITHIN_OPS, ...EMPTY_OPS] as const;

/** Operators per property, in menu order (the first one is the default for a new condition). */
export const OPS_FOR: Record<FilterProp, readonly FilterOp[]> = {
  stage: EQ_OPS,
  stage_category: EQ_OPS,
  brand: [...EQ_OPS, ...EMPTY_OPS],
  source_type: [...EQ_OPS, ...EMPTY_OPS],
  priority: EQ_OPS,
  channel: [...CONTAINS_OPS, ...EMPTY_OPS],
  overdue: ['is'],
  received: DATE_OPS,
  shoot: DATE_OPS,
  write_due: DATE_OPS,
  publish_planned: DATE_OPS,
  embargo: DATE_OPS,
  product: CONTAINS_OPS,
  title: [...CONTAINS_OPS, ...EMPTY_OPS],
};

export const CONNECTIVES = ['and', 'or'] as const;
export type Connective = (typeof CONNECTIVES)[number];
export const MAX_RULES = 20;

export const isGroup = (node: FilterNode): node is FilterGroup => 'rules' in node;

// ---------------------------------------------------------------- sorts, groups, properties

export const SORT_PROPS = [
  'product',
  'brand',
  'stage',
  'priority',
  'source_type',
  'received',
  'shoot',
  'write_due',
  'publish_planned',
  'embargo',
  'updated',
] as const;
export type SortProp = (typeof SORT_PROPS)[number];
export const SORT_PROP_LABEL: Record<SortProp, string> = {
  product: '제품명',
  brand: '브랜드',
  stage: '단계',
  priority: '우선순위',
  source_type: '입수 형태',
  received: '입고일',
  shoot: '촬영일',
  write_due: '작성 마감',
  publish_planned: '발행 예정',
  embargo: '엠바고',
  updated: '최근 수정',
};
export const MAX_SORTS = 5;

export const GROUP_PROPS = ['stage', 'stage_category', 'brand', 'source_type', 'priority'] as const;
export type GroupProp = (typeof GROUP_PROPS)[number];
export const GROUP_PROP_LABEL: Record<GroupProp, string> = {
  stage: '단계',
  stage_category: '단계 분류',
  brand: '브랜드',
  source_type: '입수 형태',
  priority: '우선순위',
};

/** Columns (list) and card fields (board) that can be shown or hidden. The product name always shows. */
export const PROPERTY_KEYS = [
  'brand',
  'stage',
  'source_type',
  'received',
  'shoot',
  'write_due',
  'publish_planned',
  'embargo',
  'priority',
  'channels',
  'next_date',
] as const;
export type PropertyKey = (typeof PROPERTY_KEYS)[number];
export const PROPERTY_LABEL: Record<PropertyKey, string> = {
  brand: '브랜드',
  stage: '단계',
  source_type: '입수 형태',
  received: '입고',
  shoot: '촬영',
  write_due: '작성 마감',
  publish_planned: '발행 예정',
  embargo: '엠바고',
  priority: '우선순위',
  channels: '채널',
  next_date: '다음 일정',
};
export const PROPERTIES_FOR: Record<Layout, readonly PropertyKey[]> = {
  list: PROPERTY_KEYS.filter((k) => k !== 'next_date'),
  board: ['brand', 'stage', 'source_type', 'priority', 'channels', 'next_date'],
  calendar: [],
};

// ---------------------------------------------------------------- the config

const EMPTY_FILTER: FilterRoot = { op: 'and', rules: [] };

/** What a new view of each layout starts with (and what an unreadable stored config falls back to). */
export function defaultConfig(layout: Layout): ViewConfig {
  switch (layout) {
    case 'list':
      return { v: 1, filter: EMPTY_FILTER, sorts: [], groupBy: null, hidden: ['embargo', 'channels'], calendarFields: [] };
    case 'board':
      return {
        v: 1,
        filter: EMPTY_FILTER,
        sorts: [{ prop: 'priority', dir: 'asc' }],
        groupBy: 'stage',
        hidden: ['stage', 'channels'],
        calendarFields: [],
      };
    case 'calendar':
      return { v: 1, filter: EMPTY_FILTER, sorts: [], groupBy: null, hidden: [], calendarFields: [...CALENDAR_FIELDS] };
  }
}

function canonicalRule(r: FilterRule): FilterRule {
  return ('value' in r ? { prop: r.prop, op: r.op, value: r.value } : { prop: r.prop, op: r.op }) as FilterRule;
}

/**
 * Layout rules + a stable key order, so two equal configs serialize identically (the "저장 안 됨"
 * check compares serializations): a board is always grouped (by stage unless chosen), a calendar has
 * no sorts/groups, only a calendar plots date fields, hidden properties are those the layout has;
 * lists are deduplicated and kept in menu order.
 */
export function normalizeConfig(layout: Layout, c: ViewConfig): ViewConfig {
  return {
    v: 1,
    filter: {
      op: c.filter.op,
      rules: c.filter.rules.map((n) => (isGroup(n) ? { op: n.op, rules: n.rules.map(canonicalRule) } : canonicalRule(n))),
    },
    sorts: layout === 'calendar' ? [] : c.sorts.map((s) => ({ prop: s.prop, dir: s.dir })),
    groupBy: layout === 'calendar' ? null : layout === 'board' ? (c.groupBy ?? 'stage') : c.groupBy,
    hidden: PROPERTIES_FOR[layout].filter((k) => c.hidden.includes(k)),
    calendarFields: layout === 'calendar' ? CALENDAR_FIELDS.filter((f) => c.calendarFields.includes(f)) : [],
  };
}

export const serializeConfig = (c: ViewConfig): string => JSON.stringify(c);
export const sameConfig = (a: ViewConfig, b: ViewConfig): boolean => serializeConfig(a) === serializeConfig(b);

/** Number of conditions (including those inside groups) — the badge on the 필터 button. */
export function countRules(filter: FilterRoot): number {
  return filter.rules.reduce((n, node) => n + (isGroup(node) ? node.rules.length : 1), 0);
}

// ---------------------------------------------------------------- new conditions (editor defaults)

export interface RuleContext {
  stages: { id: number }[];
  brands: { id: number }[];
}

/** A complete, valid condition for `prop` (the editor never holds a half-filled rule). */
export function defaultRule(prop: FilterProp, ctx: RuleContext, op: FilterOp = OPS_FOR[prop][0]!): FilterRule {
  if (op === 'is_empty' || op === 'is_not_empty') return { prop, op } as FilterRule;
  switch (prop) {
    case 'stage':
      return ctx.stages[0] ? { prop, op: op as 'is', value: ctx.stages[0].id } : { prop: 'stage_category', op: 'is', value: 'todo' };
    case 'brand':
      return ctx.brands[0] ? { prop, op: op as 'is', value: ctx.brands[0].id } : { prop, op: 'is_empty' };
    case 'stage_category':
      return { prop, op: op as 'is', value: 'in_progress' };
    case 'source_type':
      return { prop, op: op as 'is', value: 'loan' };
    case 'priority':
      return { prop, op: op as 'is', value: 'high' };
    case 'channel':
      return { prop, op: op as 'contains', value: 'youtube' };
    case 'overdue':
      return { prop, op: 'is', value: true };
    case 'product':
    case 'title':
      return { prop, op: op as 'contains', value: '' };
    default:
      return op === 'within_next_days' || op === 'within_past_days'
        ? { prop, op, value: 7 }
        : { prop, op: op as 'on', value: 'today' };
  }
}

// ---------------------------------------------------------------- URLs

/**
 * A view's URL; `draft` (when it differs from the saved config) rides along as `?cfg=`, with the
 * version it is based on as `?base=` (omitted when unknown).
 */
export function viewHref(
  layout: Layout,
  viewId: number | null,
  draft: ViewConfig | null,
  extra: Record<string, string | undefined> = {},
  base: number | null = null,
): string {
  const params = new URLSearchParams();
  if (viewId !== null) params.set(VIEW_PARAM, String(viewId));
  if (draft) {
    params.set(DRAFT_PARAM, serializeConfig(draft));
    if (base !== null) params.set(BASE_PARAM, String(base));
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') params.set(k, v);
  const qs = params.toString();
  return qs ? `${VIEW_PATH[layout]}?${qs}` : VIEW_PATH[layout];
}

/** The table's pre-views query parameters (`/reviews?stage=3`, `?brand=2&sort=shoot`, …). */
export const LEGACY_LIST_PARAMS = ['q', 'stage', 'category', 'brand', 'field', 'from', 'to', 'sort', 'dir'] as const;
