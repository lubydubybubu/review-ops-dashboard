import { z } from 'zod';
import { isIsoDate, isTimeOfDay } from './domain/dates';
import {
  ANCHOR_FIELDS,
  CALENDAR_FIELDS,
  CATEGORY_KEYS,
  CHANNELS,
  PRIORITIES,
  SOURCE_TYPES,
} from './domain/review';

/** Treat '' and whitespace-only form values as "not set". */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

const id = z.coerce.number().int().positive();
const optionalId = z.preprocess(blankToNull, id.nullable()).default(null);

export const isoDate = z.string().refine(isIsoDate, '날짜 형식이 올바르지 않습니다.');
const optionalDate = z.preprocess(blankToNull, isoDate.nullable()).default(null);

export const timeOfDay = z.string().refine(isTimeOfDay, '시간 형식이 올바르지 않습니다.');
const optionalTime = z.preprocess(blankToNull, timeOfDay.nullable()).default(null);

const optionalText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max, `${max}자 이하로 입력해 주세요.`).nullable()).default(null);

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\/\S+$/i.test(v), 'http:// 또는 https:// 로 시작하는 주소를 입력해 주세요.');

const productName = z
  .string('제품명을 입력해 주세요.')
  .trim()
  .min(1, '제품명을 입력해 주세요.')
  .max(200, '200자 이하로 입력해 주세요.');

const sourceType = z.preprocess(blankToNull, z.enum(SOURCE_TYPES).nullable()).default(null);

// ---------------------------------------------------------------- reviews

export const reviewCreateSchema = z
  .object({
    productName,
    templateId: optionalId,
    stageId: optionalId,
    brandId: optionalId,
    sourceType,
    anchorField: z.preprocess(blankToNull, z.enum(ANCHOR_FIELDS).nullable()).default(null),
    anchorDate: optionalDate,
  })
  .refine((v) => (v.anchorField === null) === (v.anchorDate === null), {
    message: '날짜와 날짜 종류를 함께 골라 주세요.',
    path: ['anchorDate'],
  });
export type ReviewCreateInput = z.infer<typeof reviewCreateSchema>;

/** `YYYY-MM-DDTHH:MM` from <input type="datetime-local">, read as KST. */
const localDateTime = z
  .string()
  .refine((v) => {
    const [d, t] = v.split('T');
    return !!d && !!t && isIsoDate(d) && isTimeOfDay(t.slice(0, 5));
  }, '날짜와 시간을 확인해 주세요.');

export const reviewUpdateSchema = z
  .object({
    productName,
    title: optionalText(200),
    brandId: optionalId,
    sourceType,
    stageId: id,
    priority: z.enum(PRIORITIES),
    channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length).default([]),
    receivedOn: optionalDate,
    shootOn: optionalDate,
    shootStartTime: optionalTime,
    shootEndTime: optionalTime,
    writeDueOn: optionalDate,
    publishPlannedOn: optionalDate,
    embargoUntil: optionalDate,
    publishedAtLocal: z.preprocess(blankToNull, localDateTime.nullable()).default(null),
    publishedUrl: z.preprocess(blankToNull, httpUrl.nullable()).default(null),
    notesMd: z.string().max(100_000).default(''),
  })
  .superRefine((v, ctx) => {
    const before = (a: string | null, b: string | null) => a !== null && b !== null && a > b;
    if (before(v.receivedOn, v.shootOn))
      ctx.addIssue({ code: 'custom', path: ['shootOn'], message: '촬영일은 입고일 이후여야 합니다.' });
    if (before(v.shootOn, v.writeDueOn))
      ctx.addIssue({ code: 'custom', path: ['writeDueOn'], message: '작성 마감은 촬영일 이후여야 합니다.' });
    if (before(v.shootOn, v.publishPlannedOn))
      ctx.addIssue({ code: 'custom', path: ['publishPlannedOn'], message: '발행 예정일은 촬영일 이후여야 합니다.' });
    if (v.shootStartTime && !v.shootOn)
      ctx.addIssue({ code: 'custom', path: ['shootStartTime'], message: '촬영 시간을 넣으려면 촬영일이 필요합니다.' });
    if (v.shootEndTime && !v.shootStartTime)
      ctx.addIssue({ code: 'custom', path: ['shootEndTime'], message: '시작 시간을 먼저 입력해 주세요.' });
    if (v.shootStartTime && v.shootEndTime && v.shootEndTime <= v.shootStartTime)
      ctx.addIssue({ code: 'custom', path: ['shootEndTime'], message: '종료 시간은 시작 시간보다 늦어야 합니다.' });
  });
export type ReviewUpdateInput = z.infer<typeof reviewUpdateSchema>;

export const stageMoveSchema = z.object({ reviewId: id, stageId: id });

/**
 * Calendar drag: move one date field of one review. For 촬영 the drop may carry a time
 * range (week view); without it an existing shoot time-of-day is kept.
 */
export const dateMoveSchema = z
  .object({
    reviewId: id,
    field: z.enum(CALENDAR_FIELDS),
    date: isoDate,
    startTime: optionalTime,
    endTime: optionalTime,
  })
  .refine((v) => v.field === 'shoot' || (v.startTime === null && v.endTime === null), {
    message: '시간은 촬영 일정에만 지정할 수 있습니다.',
    path: ['startTime'],
  })
  .refine((v) => v.endTime === null || (v.startTime !== null && v.endTime > v.startTime), {
    message: '종료 시간은 시작 시간보다 늦어야 합니다.',
    path: ['endTime'],
  });
export type DateMoveInput = z.infer<typeof dateMoveSchema>;

export const calendarRangeSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    fields: z.array(z.enum(CALENDAR_FIELDS)).max(CALENDAR_FIELDS.length),
  })
  .refine((v) => v.from < v.to, { message: '기간이 올바르지 않습니다.', path: ['to'] });

export const searchSchema = z.object({ q: z.string().trim().max(100) });

export const checklistAddSchema = z.object({
  reviewId: id,
  title: z.string().trim().min(1, '항목을 입력해 주세요.').max(200),
});
export const checklistToggleSchema = z.object({ itemId: id, done: z.boolean() });

// ---------------------------------------------------------------- brands

export const BRAND_STATUSES = ['prospect', 'active', 'paused'] as const;

export const brandCreateSchema = z.object({
  name: z.string('브랜드 이름을 입력해 주세요.').trim().min(1, '브랜드 이름을 입력해 주세요.').max(120),
  status: z.enum(BRAND_STATUSES).default('active'),
  category: optionalText(60),
  website: z.preprocess(blankToNull, httpUrl.nullable()).default(null),
});
export type BrandCreateInput = z.infer<typeof brandCreateSchema>;

export const brandUpdateSchema = brandCreateSchema.extend({ id });
export type BrandUpdateInput = z.infer<typeof brandUpdateSchema>;

// ---------------------------------------------------------------- settings

export const settingsSchema = z
  .object({
    weekStart: z.number().int().min(0).max(6),
    showWeekends: z.boolean(),
    timeFormat24h: z.boolean(),
    theme: z.enum(['system', 'light', 'dark']),
    calendarFields: z.array(z.enum(CALENDAR_FIELDS)).max(CALENDAR_FIELDS.length),
    calendarView: z.enum(['month', 'week']),
  })
  .partial();
export type SettingsInput = z.infer<typeof settingsSchema>;

const stageName = z.string().trim().min(1, '단계 이름을 입력해 주세요.').max(40, '40자 이하로 입력해 주세요.');
const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, '색상 형식이 올바르지 않습니다.');

export const stageCreateSchema = z.object({
  categoryKey: z.enum(CATEGORY_KEYS),
  name: stageName,
  color: hexColor.default('#8A8A8A'),
});
export const stageUpdateSchema = z.object({ id, name: stageName, color: hexColor });

const offset = z.preprocess(blankToNull, z.coerce.number().int().min(0).max(365).nullable()).default(null);

export const templateUpdateSchema = z.object({
  id,
  name: z.string().trim().min(1, '템플릿 이름을 입력해 주세요.').max(80),
  sourceType,
  initialStageId: optionalId,
  shootOffsetDays: offset,
  writeOffsetDays: offset,
  publishOffsetDays: offset,
  bodyMd: z.string().max(20_000).default(''),
  checklist: z.array(z.string().trim().min(1).max(200)).max(30, '체크리스트는 30개까지입니다.').default([]),
});
export type TemplateUpdateInput = z.infer<typeof templateUpdateSchema>;

// ---------------------------------------------------------------- helpers

/** First message per field, for showing next to inputs. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    out[key] ??= issue.message;
  }
  return out;
}
