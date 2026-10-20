import type { IsoDate, IsoInstant } from './dates';

export const SOURCE_TYPES = ['loan', 'gift', 'purchase'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  loan: '대여',
  gift: '제공',
  purchase: '구매',
};

export const PRIORITIES = ['high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABEL: Record<Priority, string> = { high: '높음', normal: '보통', low: '낮음' };

export const CHANNELS = ['youtube', 'shorts', 'instagram', 'blog', 'tiktok', 'threads'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = {
  youtube: '유튜브',
  shorts: '쇼츠',
  instagram: '인스타그램',
  blog: '블로그',
  tiktok: '틱톡',
  threads: '스레드',
};

export const CATEGORY_KEYS = ['todo', 'in_progress', 'done'] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];
export const CATEGORY_LABEL: Record<CategoryKey, string> = {
  todo: '할 일',
  in_progress: '진행 중',
  done: '완료',
};

/** Date fields a review can show on the calendar, in display order. */
export const CALENDAR_FIELDS = ['shoot', 'write_due', 'publish_planned', 'embargo'] as const;
export type CalendarField = (typeof CALENDAR_FIELDS)[number];

export const CALENDAR_FIELD_META: Record<
  CalendarField,
  { label: string; color: string; /** a missed date makes the review overdue */ isDeadline: boolean }
> = {
  shoot: { label: '촬영', color: '#4C7DD9', isDeadline: false },
  write_due: { label: '작성 마감', color: '#C88A12', isDeadline: true },
  publish_planned: { label: '발행 예정', color: '#2F9E6E', isDeadline: true },
  embargo: { label: '엠바고', color: '#8B5CF6', isDeadline: false },
};

/** Fields quick create can anchor a new review on (calendar fields + 입고일). */
export const ANCHOR_FIELDS = ['received', 'shoot', 'write_due', 'publish_planned'] as const;
export type AnchorField = (typeof ANCHOR_FIELDS)[number];
export const ANCHOR_FIELD_LABEL: Record<AnchorField, string> = {
  received: '입고',
  shoot: '촬영',
  write_due: '작성 마감',
  publish_planned: '발행 예정',
};

export interface Stage {
  id: number;
  name: string;
  color: string;
  categoryKey: CategoryKey;
  sort: number;
  isDefault: boolean;
  isOnHold: boolean;
  archivedAt: IsoInstant | null;
}

export interface ReviewDates {
  receivedOn: IsoDate | null;
  shootOn: IsoDate | null;
  writeDueOn: IsoDate | null;
  publishPlannedOn: IsoDate | null;
}
