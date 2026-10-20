import { describe, expect, it } from 'vitest';
import {
  brandCreateSchema,
  calendarRangeSchema,
  dateMoveSchema,
  fieldErrors,
  reviewCreateSchema,
  reviewUpdateSchema,
  settingsSchema,
  templateUpdateSchema,
} from '../../src/lib/validation';

const validUpdate = {
  productName: '헤드폰',
  title: '',
  brandId: '',
  sourceType: '',
  stageId: 3,
  priority: 'normal',
  channels: ['youtube'],
  receivedOn: '2026-10-01',
  shootOn: '2026-10-05',
  shootStartTime: '',
  shootEndTime: '',
  writeDueOn: '2026-10-09',
  publishPlannedOn: '',
  embargoUntil: '',
  publishedAtLocal: '',
  publishedUrl: '',
  notesMd: '',
};

describe('zod validation', () => {
  it('review create: only a product name is required, trimmed', () => {
    expect(reviewCreateSchema.parse({ productName: '  키보드 ' })).toEqual({
      productName: '키보드',
      templateId: null,
      stageId: null,
      brandId: null,
      sourceType: null,
      anchorField: null,
      anchorDate: null,
    });
  });

  it('review create: rejects blank names with a Korean message', () => {
    const result = reviewCreateSchema.safeParse({ productName: '   ' });
    expect(result.success).toBe(false);
    expect(fieldErrors(result.error!)).toEqual({ productName: '제품명을 입력해 주세요.' });
    expect(reviewCreateSchema.safeParse({}).success).toBe(false);
    expect(reviewCreateSchema.safeParse({ productName: 'x'.repeat(201) }).success).toBe(false);
  });

  it('review create: anchor date and field go together; dates must be real', () => {
    expect(reviewCreateSchema.safeParse({ productName: 'a', anchorDate: '2026-10-19' }).success).toBe(false);
    expect(reviewCreateSchema.safeParse({ productName: 'a', anchorField: 'shoot' }).success).toBe(false);
    expect(
      reviewCreateSchema.safeParse({ productName: 'a', anchorField: 'shoot', anchorDate: '2026-02-30' }).success,
    ).toBe(false);
    expect(
      reviewCreateSchema.parse({ productName: 'a', anchorField: 'shoot', anchorDate: '2026-10-19', templateId: '3' }),
    ).toMatchObject({ anchorField: 'shoot', anchorDate: '2026-10-19', templateId: 3 });
  });

  it('review update: blanks become null', () => {
    const parsed = reviewUpdateSchema.parse(validUpdate);
    expect(parsed).toMatchObject({ title: null, brandId: null, sourceType: null, publishPlannedOn: null, publishedUrl: null });
  });

  it('review update: mirrors the DB date-order rules', () => {
    const r = reviewUpdateSchema.safeParse({ ...validUpdate, receivedOn: '2026-10-06', writeDueOn: '2026-10-04' });
    expect(r.success).toBe(false);
    expect(fieldErrors(r.error!)).toEqual({
      shootOn: '촬영일은 입고일 이후여야 합니다.',
      writeDueOn: '작성 마감은 촬영일 이후여야 합니다.',
    });
  });

  it('review update: shoot time window rules', () => {
    expect(reviewUpdateSchema.safeParse({ ...validUpdate, shootStartTime: '14:00', shootEndTime: '13:00' }).success).toBe(
      false,
    );
    expect(reviewUpdateSchema.safeParse({ ...validUpdate, shootEndTime: '13:00' }).success).toBe(false);
    expect(reviewUpdateSchema.safeParse({ ...validUpdate, shootOn: '', writeDueOn: '', shootStartTime: '10:00' }).success).toBe(
      false,
    );
    expect(reviewUpdateSchema.safeParse({ ...validUpdate, shootStartTime: '24:00' }).success).toBe(false);
    expect(reviewUpdateSchema.safeParse({ ...validUpdate, shootStartTime: '09:00', shootEndTime: '10:30' }).success).toBe(
      true,
    );
  });

  it('review update: rejects unknown channels, non-http URLs and bad datetimes', () => {
    expect(reviewUpdateSchema.safeParse({ ...validUpdate, channels: ['myspace'] }).success).toBe(false);
    expect(reviewUpdateSchema.safeParse({ ...validUpdate, publishedUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(reviewUpdateSchema.safeParse({ ...validUpdate, publishedAtLocal: '2026-10-19' }).success).toBe(false);
    expect(reviewUpdateSchema.safeParse({ ...validUpdate, publishedAtLocal: '2026-10-19T21:30' }).success).toBe(true);
  });

  it('calendar drag: times only for 촬영, end after start', () => {
    expect(dateMoveSchema.safeParse({ reviewId: 1, field: 'publish_planned', date: '2026-10-12' }).success).toBe(true);
    expect(
      dateMoveSchema.safeParse({ reviewId: 1, field: 'publish_planned', date: '2026-10-12', startTime: '10:00' }).success,
    ).toBe(false);
    expect(
      dateMoveSchema.safeParse({ reviewId: 1, field: 'shoot', date: '2026-10-12', startTime: '10:00', endTime: '09:00' })
        .success,
    ).toBe(false);
    expect(dateMoveSchema.safeParse({ reviewId: 1, field: 'received', date: '2026-10-12' }).success).toBe(false);
    expect(dateMoveSchema.safeParse({ reviewId: -1, field: 'shoot', date: '2026-10-12' }).success).toBe(false);
  });

  it('calendar range must be ordered and fields known', () => {
    expect(calendarRangeSchema.safeParse({ from: '2026-10-01', to: '2026-11-01', fields: ['shoot'] }).success).toBe(true);
    expect(calendarRangeSchema.safeParse({ from: '2026-11-01', to: '2026-10-01', fields: [] }).success).toBe(false);
    expect(calendarRangeSchema.safeParse({ from: '2026-10-01', to: '2026-11-01', fields: ['x'] }).success).toBe(false);
  });

  it('brand: name required, website must be http(s)', () => {
    expect(brandCreateSchema.parse({ name: ' Kestrel ', website: '' })).toEqual({
      name: 'Kestrel',
      status: 'active',
      category: null,
      website: null,
    });
    expect(brandCreateSchema.safeParse({ name: '' }).success).toBe(false);
    expect(brandCreateSchema.safeParse({ name: 'a', website: 'ftp://x' }).success).toBe(false);
    expect(brandCreateSchema.safeParse({ name: 'a', status: 'deleted' }).success).toBe(false);
  });

  it('settings: partial updates, bounded values', () => {
    expect(settingsSchema.parse({ weekStart: 0 })).toEqual({ weekStart: 0 });
    expect(settingsSchema.safeParse({ weekStart: 7 }).success).toBe(false);
    expect(settingsSchema.safeParse({ theme: 'blue' }).success).toBe(false);
  });

  it('template: offsets 0–365, checklist items non-empty', () => {
    const base = { id: 1, name: '대여', checklist: ['a'] };
    expect(templateUpdateSchema.parse({ ...base, writeOffsetDays: '4', shootOffsetDays: '' })).toMatchObject({
      writeOffsetDays: 4,
      shootOffsetDays: null,
    });
    expect(templateUpdateSchema.safeParse({ ...base, writeOffsetDays: -1 }).success).toBe(false);
    expect(templateUpdateSchema.safeParse({ ...base, checklist: ['  '] }).success).toBe(false);
  });
});
