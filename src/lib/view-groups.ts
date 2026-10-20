import type { ReviewListItem } from '@/server/db/reviews';
import {
  CATEGORY_KEYS,
  CATEGORY_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  SOURCE_TYPE_LABEL,
  SOURCE_TYPES,
  type Stage,
} from './domain/review';
import type { GroupProp } from './view-config';

export interface ReviewGroup {
  key: string;
  label: string;
  color?: string;
  /** set when grouped by stage: the column is a drop target for that stage */
  stage?: Stage;
  items: ReviewListItem[];
}

interface Option {
  key: string;
  label: string;
  color?: string;
  stage?: Stage;
}

function keyOf(r: ReviewListItem, by: GroupProp): string {
  switch (by) {
    case 'stage':
      return `stage-${r.stageId}`;
    case 'stage_category':
      return r.categoryKey;
    case 'brand':
      return r.brandId === null ? 'none' : `brand-${r.brandId}`;
    case 'source_type':
      return r.sourceType ?? 'none';
    case 'priority':
      return r.priority;
  }
}

function fallbackLabel(r: ReviewListItem, by: GroupProp): Option {
  if (by === 'stage') return { key: keyOf(r, by), label: r.stageName, color: r.stageColor };
  if (by === 'brand' && r.brandName) return { key: keyOf(r, by), label: r.brandName };
  return { key: keyOf(r, by), label: '없음' };
}

function optionsFor(by: GroupProp, stages: Stage[]): Option[] {
  switch (by) {
    case 'stage':
      return stages.map((s) => ({ key: `stage-${s.id}`, label: s.name, color: s.color, stage: s }));
    case 'stage_category':
      return CATEGORY_KEYS.map((k) => ({ key: k, label: CATEGORY_LABEL[k] }));
    case 'source_type':
      return [...SOURCE_TYPES.map((k) => ({ key: k, label: SOURCE_TYPE_LABEL[k] })), { key: 'none', label: '입수 형태 없음' }];
    case 'priority':
      return PRIORITIES.map((k) => ({ key: k, label: PRIORITY_LABEL[k] }));
    case 'brand':
      return []; // brands present in the rows, by name, then "없음"
  }
}

/**
 * Partition rows (already in the view's sort order) into the group-by options, in option order.
 * `includeEmpty` keeps empty groups of the fixed option sets (board columns stay as drop targets);
 * brand groups only exist for brands that have rows.
 */
export function groupReviews(
  rows: ReviewListItem[],
  by: GroupProp,
  stages: Stage[],
  { includeEmpty }: { includeEmpty: boolean },
): ReviewGroup[] {
  const groups = new Map<string, ReviewGroup>();
  for (const option of optionsFor(by, stages)) groups.set(option.key, { ...option, items: [] });

  const extra: ReviewGroup[] = [];
  for (const r of rows) {
    const key = keyOf(r, by);
    let group = groups.get(key);
    if (!group) {
      group = { ...fallbackLabel(r, by), items: [] };
      if (by === 'brand' && r.brandId === null) group.label = '브랜드 없음';
      groups.set(key, group);
      extra.push(group);
    }
    group.items.push(r);
  }

  if (by === 'brand') {
    extra.sort((a, b) => (a.key === 'none' ? 1 : b.key === 'none' ? -1 : a.label.localeCompare(b.label, 'ko')));
  }
  const ordered = [...[...groups.values()].filter((g) => !extra.includes(g)), ...extra];
  return includeEmpty ? ordered : ordered.filter((g) => g.items.length > 0);
}
