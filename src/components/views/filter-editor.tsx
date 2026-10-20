'use client';

import { useEffect, useState } from 'react';
import { todayInSeoul } from '@/lib/domain/dates';
import {
  CATEGORY_KEYS,
  CATEGORY_LABEL,
  CHANNEL_LABEL,
  CHANNELS,
  PRIORITIES,
  PRIORITY_LABEL,
  SOURCE_TYPE_LABEL,
  SOURCE_TYPES,
  type Stage,
} from '@/lib/domain/review';
import {
  defaultRule,
  FILTER_OP_LABEL,
  FILTER_PROP_LABEL,
  FILTER_PROPS,
  hasControlChar,
  isGroup,
  MAX_RULES,
  OPS_FOR,
  type Connective,
  type FilterGroup,
  type FilterOp,
  type FilterProp,
  type FilterRoot,
  type FilterRule,
  type RuleContext,
  VIEW_DATE_MAX,
  VIEW_DATE_MIN,
} from '@/lib/view-config';
import { IconPlus, IconX } from '../icons';

interface Ctx extends RuleContext {
  stages: Stage[];
  brands: { id: number; name: string }[];
}

/** Operators whose values are interchangeable (switching between them keeps the value). */
const OP_FAMILY: Record<FilterOp, string> = {
  is: 'eq',
  is_not: 'eq',
  is_empty: 'empty',
  is_not_empty: 'empty',
  on: 'cmp',
  before: 'cmp',
  after: 'cmp',
  on_or_before: 'cmp',
  on_or_after: 'cmp',
  within_next_days: 'within',
  within_past_days: 'within',
  contains: 'contains',
  not_contains: 'contains',
};

function withOp(rule: FilterRule, op: FilterOp, ctx: Ctx): FilterRule {
  if (OP_FAMILY[op] === OP_FAMILY[rule.op] && 'value' in rule) return { ...rule, op } as FilterRule;
  return defaultRule(rule.prop, ctx, op);
}

/**
 * AND/OR conditions with one nesting level (a group holds conditions only). Every edit produces a
 * complete, valid filter, so the view can apply it immediately.
 */
export function FilterEditor({
  filter,
  onChange,
  ctx,
}: {
  filter: FilterRoot;
  onChange: (next: FilterRoot) => void;
  ctx: Ctx;
}) {
  const total = filter.rules.length;
  const setNode = (index: number, node: FilterRoot['rules'][number] | null) =>
    onChange({
      ...filter,
      rules: node === null ? filter.rules.filter((_, i) => i !== index) : filter.rules.map((n, i) => (i === index ? node : n)),
    });

  return (
    <div className="flex flex-col gap-2" data-filter-editor>
      <ConnectiveSelect value={filter.op} onChange={(op) => onChange({ ...filter, op })} label="조건 연결" />
      {filter.rules.length === 0 ? <p className="py-1 text-subtle">조건이 없습니다. 모든 리뷰가 보입니다.</p> : null}
      <ul className="flex flex-col gap-1.5">
        {filter.rules.map((node, i) =>
          isGroup(node) ? (
            <li key={i} className="rounded-md border border-line p-2" data-filter-group={i}>
              <GroupEditor group={node} ctx={ctx} onChange={(g) => setNode(i, g)} onRemove={() => setNode(i, null)} />
            </li>
          ) : (
            <li key={i}>
              <RuleEditor rule={node} ctx={ctx} onChange={(r) => setNode(i, r)} onRemove={() => setNode(i, null)} />
            </li>
          ),
        )}
      </ul>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className="btn btn-ghost h-8 px-2 text-muted"
          disabled={total >= MAX_RULES}
          onClick={() => onChange({ ...filter, rules: [...filter.rules, defaultRule('stage_category', ctx)] })}
        >
          <IconPlus className="size-3.5" />
          조건 추가
        </button>
        <button
          type="button"
          className="btn btn-ghost h-8 px-2 text-muted"
          disabled={total >= MAX_RULES}
          onClick={() =>
            onChange({ ...filter, rules: [...filter.rules, { op: filter.op === 'and' ? 'or' : 'and', rules: [defaultRule('stage_category', ctx)] }] })
          }
        >
          <IconPlus className="size-3.5" />
          조건 그룹 추가
        </button>
      </div>
    </div>
  );
}

function GroupEditor({
  group,
  ctx,
  onChange,
  onRemove,
}: {
  group: FilterGroup;
  ctx: Ctx;
  onChange: (next: FilterGroup) => void;
  onRemove: () => void;
}) {
  const setRule = (index: number, rule: FilterRule | null) => {
    const rules = rule === null ? group.rules.filter((_, i) => i !== index) : group.rules.map((r, i) => (i === index ? rule : r));
    if (rules.length === 0) onRemove();
    else onChange({ ...group, rules });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <ConnectiveSelect value={group.op} onChange={(op) => onChange({ ...group, op })} label="그룹 조건 연결" />
        <button type="button" className="btn btn-ghost ml-auto h-8 px-2 text-muted" onClick={onRemove} aria-label="조건 그룹 삭제">
          <IconX className="size-3.5" />
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {group.rules.map((rule, i) => (
          <li key={i}>
            <RuleEditor rule={rule} ctx={ctx} onChange={(r) => setRule(i, r)} onRemove={() => setRule(i, null)} />
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-ghost h-8 self-start px-2 text-muted"
        disabled={group.rules.length >= MAX_RULES}
        onClick={() => onChange({ ...group, rules: [...group.rules, defaultRule('stage_category', ctx)] })}
      >
        <IconPlus className="size-3.5" />
        그룹에 조건 추가
      </button>
    </div>
  );
}

function ConnectiveSelect({ value, onChange, label }: { value: Connective; onChange: (v: Connective) => void; label: string }) {
  return (
    <select aria-label={label} className="input h-8 w-auto text-[13px]" value={value} onChange={(e) => onChange(e.target.value as Connective)}>
      <option value="and">모든 조건을 만족 (그리고)</option>
      <option value="or">하나라도 만족 (또는)</option>
    </select>
  );
}

function RuleEditor({
  rule,
  ctx,
  onChange,
  onRemove,
}: {
  rule: FilterRule;
  ctx: Ctx;
  onChange: (next: FilterRule) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-filter-rule={rule.prop}>
      <select
        aria-label="필터 속성"
        className="input h-8 w-auto text-[13px]"
        value={rule.prop}
        onChange={(e) => onChange(defaultRule(e.target.value as FilterProp, ctx))}
      >
        {FILTER_PROPS.map((p) => (
          <option key={p} value={p}>
            {FILTER_PROP_LABEL[p]}
          </option>
        ))}
      </select>
      <select
        aria-label="필터 조건"
        className="input h-8 w-auto text-[13px]"
        value={rule.op}
        onChange={(e) => onChange(withOp(rule, e.target.value as FilterOp, ctx))}
      >
        {OPS_FOR[rule.prop].map((op) => (
          <option key={op} value={op}>
            {FILTER_OP_LABEL[op]}
          </option>
        ))}
      </select>
      <RuleValue rule={rule} ctx={ctx} onChange={onChange} />
      <button type="button" className="btn btn-ghost h-8 px-2 text-muted" onClick={onRemove} aria-label="조건 삭제">
        <IconX className="size-3.5" />
      </button>
    </div>
  );
}

const valueClass = 'input h-8 w-auto text-[13px]';

function EnumSelect<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  return (
    <select
      aria-label="필터 값"
      className={valueClass}
      value={String(value)}
      onChange={(e) => onChange(options.find(([v]) => String(v) === e.target.value)![0])}
    >
      {options.map(([v, label]) => (
        <option key={String(v)} value={String(v)}>
          {label}
        </option>
      ))}
    </select>
  );
}

function RuleValue({ rule, ctx, onChange }: { rule: FilterRule; ctx: Ctx; onChange: (next: FilterRule) => void }) {
  if (!('value' in rule)) return null;
  const set = (value: unknown) => onChange({ ...rule, value } as FilterRule);
  switch (rule.prop) {
    case 'stage': {
      const options = ctx.stages.map((s) => [s.id, `${CATEGORY_LABEL[s.categoryKey]} · ${s.name}`] as const);
      return <EnumSelect value={rule.value as number} options={options} onChange={set} />;
    }
    case 'brand':
      return <EnumSelect value={rule.value as number} options={ctx.brands.map((b) => [b.id, b.name] as const)} onChange={set} />;
    case 'stage_category':
      return <EnumSelect value={rule.value} options={CATEGORY_KEYS.map((k) => [k, CATEGORY_LABEL[k]] as const)} onChange={set} />;
    case 'source_type':
      return <EnumSelect value={rule.value as string} options={SOURCE_TYPES.map((k) => [k, SOURCE_TYPE_LABEL[k]] as const)} onChange={set} />;
    case 'priority':
      return <EnumSelect value={rule.value as string} options={PRIORITIES.map((k) => [k, PRIORITY_LABEL[k]] as const)} onChange={set} />;
    case 'channel':
      return <EnumSelect value={rule.value as string} options={CHANNELS.map((k) => [k, CHANNEL_LABEL[k]] as const)} onChange={set} />;
    case 'overdue':
      return (
        <EnumSelect
          value={rule.value ? 'yes' : 'no'}
          options={[
            ['yes', '예'],
            ['no', '아니오'],
          ]}
          onChange={(v) => set(v === 'yes')}
        />
      );
    case 'product':
    case 'title':
      return <TextValue value={String(rule.value)} onChange={set} />;
    default:
      if (rule.op === 'within_next_days' || rule.op === 'within_past_days') {
        return (
          <span className="inline-flex items-center gap-1">
            <input
              type="number"
              aria-label="일수"
              min={0}
              max={365}
              className={`${valueClass} w-20`}
              value={Number(rule.value)}
              onChange={(e) => {
                const n = Math.trunc(Number(e.target.value));
                if (Number.isFinite(n) && n >= 0 && n <= 365) set(n);
              }}
            />
            일
          </span>
        );
      }
      return <DateValue value={String(rule.value)} onChange={set} />;
  }
}

function DateValue({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      <select
        aria-label="기준 날짜"
        className={valueClass}
        value={value === 'today' ? 'today' : 'date'}
        onChange={(e) => onChange(e.target.value === 'today' ? 'today' : todayInSeoul())}
      >
        <option value="today">오늘</option>
        <option value="date">특정 날짜</option>
      </select>
      {value !== 'today' ? (
        <input
          type="date"
          aria-label="필터 날짜"
          className={`${valueClass} w-[9.5rem]`}
          min={VIEW_DATE_MIN}
          max={VIEW_DATE_MAX}
          value={value}
          // only dates a view may hold (a typed year 9999 is not applied)
          onChange={(e) => e.target.value >= VIEW_DATE_MIN && e.target.value <= VIEW_DATE_MAX && onChange(e.target.value)}
        />
      ) : null}
    </span>
  );
}

/** Text conditions apply after a short pause in typing (each change re-queries the server). */
function TextValue({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  // rows are keyed by position: when the value changes from outside (a row above removed, 되돌리기), follow it
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    setText(value);
  }
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onChange(text), 300);
    return () => clearTimeout(timer);
  }, [text, value, onChange]);
  return (
    <input
      aria-label="필터 값"
      className={`${valueClass} w-40`}
      maxLength={100}
      placeholder="포함할 글자"
      value={text}
      // control characters (pasted) are not allowed in a condition
      onChange={(e) => setText([...e.target.value].filter((ch) => !hasControlChar(ch)).join(''))}
    />
  );
}
