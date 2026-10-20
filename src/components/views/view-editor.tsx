'use client';

import {
  GROUP_PROP_LABEL,
  GROUP_PROPS,
  MAX_SORTS,
  PROPERTIES_FOR,
  PROPERTY_LABEL,
  SORT_PROP_LABEL,
  SORT_PROPS,
  type GroupProp,
  type SortProp,
  type SortSpec,
  type ViewConfig,
} from '@/lib/view-config';
import { IconPlus, IconX } from '../icons';
import { useShell } from '../shell-context';
import { FilterEditor } from './filter-editor';
import { useView } from './view-context';

export type Section = 'filter' | 'sort' | 'group' | 'properties';

/**
 * The body of one view-settings section (필터 · 정렬 · 그룹 · 속성). Loaded on demand by the toolbar
 * when a popover or the phone sheet first opens, so pages do not ship the editors up front.
 */
export function SectionBody({ section, config, update }: { section: Section; config: ViewConfig; update: (c: ViewConfig) => void }) {
  const { stages, brands } = useShell();
  const { layout } = useView();
  switch (section) {
    case 'filter':
      return <FilterEditor filter={config.filter} ctx={{ stages, brands }} onChange={(filter) => update({ ...config, filter })} />;
    case 'sort':
      return <SortEditor sorts={config.sorts} onChange={(sorts) => update({ ...config, sorts })} />;
    case 'group':
      return (
        <div>
          <label htmlFor={`group-by-${layout}`} className="label">
            그룹 기준
          </label>
          <select
            id={`group-by-${layout}`}
            className="input h-8 text-[13px]"
            value={config.groupBy ?? ''}
            onChange={(e) => update({ ...config, groupBy: (e.target.value || null) as GroupProp | null })}
          >
            {layout === 'list' ? <option value="">그룹 없음</option> : null}
            {GROUP_PROPS.map((g) => (
              <option key={g} value={g}>
                {GROUP_PROP_LABEL[g]}
              </option>
            ))}
          </select>
          {layout === 'board' && config.groupBy !== 'stage' ? (
            <p className="mt-2 text-[12px] text-subtle">카드를 끌어 단계를 바꾸려면 단계로 묶어 주세요.</p>
          ) : null}
        </div>
      );
    case 'properties':
      return (
        <fieldset>
          <legend className="label">{layout === 'board' ? '카드에 표시할 속성' : '표시할 열'}</legend>
          <ul className="flex flex-col">
            {PROPERTIES_FOR[layout].map((p) => (
              <li key={p}>
                <label className="flex items-center gap-2 py-1">
                  <input
                    type="checkbox"
                    checked={!config.hidden.includes(p)}
                    onChange={(e) =>
                      update({ ...config, hidden: e.target.checked ? config.hidden.filter((h) => h !== p) : [...config.hidden, p] })
                    }
                  />
                  {PROPERTY_LABEL[p]}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      );
  }
}

function SortEditor({ sorts, onChange }: { sorts: SortSpec[]; onChange: (next: SortSpec[]) => void }) {
  const unused = SORT_PROPS.filter((p) => !sorts.some((s) => s.prop === p));
  const set = (i: number, patch: Partial<SortSpec>) => onChange(sorts.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const swap = (i: number, j: number) => {
    const next = [...sorts];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2">
      {sorts.length === 0 ? <p className="text-subtle">정렬이 없으면 최근 수정 순입니다.</p> : null}
      <ol className="flex flex-col gap-1.5">
        {sorts.map((s, i) => (
          <li key={s.prop} className="flex items-center gap-1" data-sort-row={s.prop}>
            <span className="w-4 text-[12px] text-subtle tabular-nums">{i + 1}</span>
            <select
              aria-label="정렬 속성"
              className="input h-8 w-auto flex-1 text-[13px]"
              value={s.prop}
              onChange={(e) => set(i, { prop: e.target.value as SortProp })}
            >
              {[s.prop, ...unused].map((p) => (
                <option key={p} value={p}>
                  {SORT_PROP_LABEL[p]}
                </option>
              ))}
            </select>
            <select
              aria-label="정렬 방향"
              className="input h-8 w-auto text-[13px]"
              value={s.dir}
              onChange={(e) => set(i, { dir: e.target.value as 'asc' | 'desc' })}
            >
              <option value="asc">오름차순</option>
              <option value="desc">내림차순</option>
            </select>
            <button type="button" className="btn btn-ghost h-8 px-1.5" aria-label="위로" disabled={i === 0} onClick={() => swap(i, i - 1)}>
              ↑
            </button>
            <button
              type="button"
              className="btn btn-ghost h-8 px-1.5"
              aria-label="아래로"
              disabled={i === sorts.length - 1}
              onClick={() => swap(i, i + 1)}
            >
              ↓
            </button>
            <button type="button" className="btn btn-ghost h-8 px-1.5 text-muted" aria-label="정렬 삭제" onClick={() => onChange(sorts.filter((_, j) => j !== i))}>
              <IconX className="size-3.5" />
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="btn btn-ghost h-8 self-start px-2 text-muted"
        disabled={sorts.length >= MAX_SORTS || unused.length === 0}
        onClick={() => onChange([...sorts, { prop: unused[0]!, dir: 'asc' }])}
      >
        <IconPlus className="size-3.5" />
        정렬 추가
      </button>
    </div>
  );
}
