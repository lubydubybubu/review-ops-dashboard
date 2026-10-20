import { isIsoDate, type IsoDate } from '@/lib/domain/dates';
import {
  dateRuleRange,
  isGroup,
  type DateProp,
  type FilterNode,
  type FilterRoot,
  type FilterRule,
  type SortProp,
  type SortSpec,
} from '@/lib/views';
import { likePattern } from './client';

/*
 * Saved-view config → SQL. Every column and operator below comes from a closed map keyed by the
 * config's property/operator names; every user value becomes a bind parameter through `param`.
 * Anything not in the maps throws (zod rejects it earlier; this is the second fence).
 * Aliases: `r` = reviews, `s` = workflow_stages (filters); sorts may also use `c` = stage_categories
 * and `b` = brands (the list query joins them).
 */

export class ViewSqlError extends Error {
  constructor(what: string) {
    super(`unsupported view ${what}`);
    this.name = 'ViewSqlError';
  }
}

export interface SqlContext {
  /** registers a bind value, returns its placeholder (`$n`) */
  param: (value: unknown) => string;
  /** KST calendar day used for `today`, "within N days" and the overdue rule */
  today: IsoDate;
}

/** A fresh parameter list (optionally continuing after `offset` existing parameters). */
export function sqlParams(offset = 0): { values: unknown[]; param: (value: unknown) => string } {
  const values: unknown[] = [];
  return {
    values,
    param: (value) => {
      values.push(value);
      return `$${offset + values.length}`;
    },
  };
}

const own = <T extends object>(map: T, key: PropertyKey): key is keyof T => Object.hasOwn(map, key);

const EQ_COLUMN = {
  stage: 'r.stage_id',
  stage_category: 's.category_key',
  brand: 'r.brand_id',
  source_type: 'r.source_type',
  priority: 'r.priority',
} as const;

const DATE_COLUMN: Record<DateProp, string> = {
  received: 'r.received_on',
  shoot: 'r.shoot_on',
  write_due: 'r.write_due_on',
  publish_planned: 'r.publish_planned_on',
  embargo: 'r.embargo_until',
};

const DATE_CMP = { on: '=', before: '<', after: '>', on_or_before: '<=', on_or_after: '>=' } as const;

const TEXT_COLUMN = { product: 'r.product_name', title: 'r.title' } as const;

const NULLABLE_COLUMN = { brand: 'r.brand_id', source_type: 'r.source_type', title: 'r.title', ...DATE_COLUMN } as const;

function compileRule(rule: FilterRule, ctx: SqlContext): string {
  const { prop, op } = rule;
  const value = 'value' in rule ? rule.value : undefined;

  if (op === 'is_empty' || op === 'is_not_empty') {
    const not = op === 'is_not_empty' ? 'not ' : '';
    if (prop === 'channel') return `${not}(cardinality(r.channels) = 0)`;
    if (!own(NULLABLE_COLUMN, prop)) throw new ViewSqlError(`property ${String(prop)}`);
    return `${NULLABLE_COLUMN[prop]} is ${not}null`;
  }

  if (prop === 'overdue') {
    if (op !== 'is' || typeof value !== 'boolean') throw new ViewSqlError('overdue condition');
    // SQL mirror of overdueFields(): a missed 작성 마감 / 발행 예정 while the stage is not 완료.
    const p = ctx.param(ctx.today);
    const overdue = `coalesce(s.category_key <> 'done' and (r.write_due_on < ${p}::date or r.publish_planned_on < ${p}::date), false)`;
    return value ? overdue : `not ${overdue}`;
  }

  if (prop === 'channel') {
    if (op !== 'contains' && op !== 'not_contains') throw new ViewSqlError(`operator ${String(op)}`);
    const test = `${ctx.param(value)}::text = any(r.channels)`;
    return op === 'contains' ? test : `not (${test})`;
  }

  if (own(TEXT_COLUMN, prop)) {
    if (typeof value !== 'string') throw new ViewSqlError('text value');
    const column = TEXT_COLUMN[prop];
    const p = ctx.param(likePattern(value));
    if (op === 'contains') return `${column} ilike ${p}`;
    if (op === 'not_contains') return `coalesce(${column}, '') not ilike ${p}`;
    throw new ViewSqlError(`operator ${String(op)}`);
  }

  if (own(DATE_COLUMN, prop)) {
    const column = DATE_COLUMN[prop];
    if (op === 'within_next_days' || op === 'within_past_days') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 365) throw new ViewSqlError('day count');
      const { from, to } = dateRuleRange(op, value, ctx.today);
      return `(${column} >= ${ctx.param(from)}::date and ${column} <= ${ctx.param(to)}::date)`;
    }
    // A fixed day: one comparison against the (schema-validated) date, no day arithmetic.
    if (!own(DATE_CMP, op)) throw new ViewSqlError(`operator ${String(op)}`);
    if (typeof value !== 'string' || (value !== 'today' && !isIsoDate(value))) throw new ViewSqlError('date value');
    return `${column} ${DATE_CMP[op]} ${ctx.param(value === 'today' ? ctx.today : value)}::date`;
  }

  if (own(EQ_COLUMN, prop)) {
    if (typeof value !== 'string' && typeof value !== 'number') throw new ViewSqlError('value');
    const column = EQ_COLUMN[prop];
    // ids are bigint columns; everything else here is text
    const cast = prop === 'stage' || prop === 'brand' ? '::bigint' : '::text';
    if (op === 'is') return `${column} = ${ctx.param(value)}${cast}`;
    if (op === 'is_not') return `${column} is distinct from ${ctx.param(value)}${cast}`;
    throw new ViewSqlError(`operator ${String(op)}`);
  }

  throw new ViewSqlError(`property ${String(prop)}`);
}

function joinNodes(op: 'and' | 'or', parts: string[]): string {
  if (op !== 'and' && op !== 'or') throw new ViewSqlError(`connective ${String(op)}`);
  if (parts.length === 0) return 'true';
  return parts.length === 1 ? parts[0]! : `(${parts.map((p) => `(${p})`).join(` ${op} `)})`;
}

function compileNode(node: FilterNode, ctx: SqlContext, depth: number): string {
  if (isGroup(node)) {
    if (depth > 0) throw new ViewSqlError('nesting deeper than one level');
    return joinNodes(
      node.op,
      node.rules.map((r) => {
        if (isGroup(r as FilterNode)) throw new ViewSqlError('nesting deeper than one level');
        return compileRule(r, ctx);
      }),
    );
  }
  return compileRule(node, ctx);
}

/** WHERE fragment for a view filter; `true` when it has no conditions (an empty group matches all). */
export function compileFilter(filter: FilterRoot, ctx: SqlContext): string {
  return joinNodes(
    filter.op,
    filter.rules.map((n) => compileNode(n, ctx, 0)),
  );
}

const SORT_SQL: Record<SortProp, readonly string[]> = {
  product: ['lower(r.product_name)'],
  brand: ['lower(b.name)'],
  stage: ['c.sort', 's.sort'],
  priority: ["array_position(array['high','normal','low']::text[], r.priority)"],
  source_type: ["array_position(array['loan','gift','purchase']::text[], r.source_type)"],
  received: ['r.received_on'],
  shoot: ['r.shoot_on'],
  write_due: ['r.write_due_on'],
  publish_planned: ['r.publish_planned_on'],
  embargo: ['r.embargo_until'],
  updated: ['r.updated_at'],
};

/** ORDER BY for the sorts in priority order; no sorts = most recently updated first (the old default). */
export function compileOrder(sorts: readonly SortSpec[]): string {
  if (sorts.length === 0) return 'r.updated_at desc, r.id desc';
  const terms = sorts.flatMap(({ prop, dir }) => {
    if (!own(SORT_SQL, prop)) throw new ViewSqlError(`sort ${String(prop)}`);
    if (dir !== 'asc' && dir !== 'desc') throw new ViewSqlError(`direction ${String(dir)}`);
    return SORT_SQL[prop].map((expr) => `${expr} ${dir} nulls last`);
  });
  return [...terms, 'r.id'].join(', ');
}
