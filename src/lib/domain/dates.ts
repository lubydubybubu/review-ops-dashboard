/**
 * Date helpers. Rule: calendar dates are plain `YYYY-MM-DD` strings that mean a day in
 * Asia/Seoul; instants are ISO-8601 UTC strings. Korea has no DST (since 1988), so the
 * offset is a constant +09:00 and day arithmetic can be done in UTC without drift.
 */

export const APP_TIME_ZONE = 'Asia/Seoul';
const KST_OFFSET_MINUTES = 9 * 60;
const DAY_MS = 86_400_000;

/** A calendar day in Asia/Seoul, `YYYY-MM-DD`. */
export type IsoDate = string;
/** An instant, ISO-8601 in UTC (`2026-10-19T01:00:00.000Z`). */
export type IsoInstant = string;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function isTimeOfDay(value: string): boolean {
  return TIME_RE.test(value);
}

function toUtcMidnight(date: IsoDate): number {
  if (!isIsoDate(date)) throw new RangeError(`invalid date: ${date}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtcMidnight(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The KST calendar day that contains `instant`. */
export function kstDateOf(instant: Date | IsoInstant): IsoDate {
  const ms = typeof instant === 'string' ? Date.parse(instant) : instant.getTime();
  return fromUtcMidnight(ms + KST_OFFSET_MINUTES * 60_000);
}

/** Today in Asia/Seoul. Pass `now` for deterministic tests. */
export function todayInSeoul(now: Date = new Date()): IsoDate {
  return kstDateOf(now);
}

/** KST wall-clock time `HH:MM` of an instant. */
export function kstTimeOf(instant: IsoInstant): string {
  const shifted = new Date(Date.parse(instant) + KST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(11, 16);
}

/** The instant for a KST day + wall-clock time. */
export function kstInstant(date: IsoDate, time: string): IsoInstant {
  if (!isTimeOfDay(time)) throw new RangeError(`invalid time: ${time}`);
  const [h, mi] = time.split(':').map(Number) as [number, number];
  return new Date(toUtcMidnight(date) + (h * 60 + mi - KST_OFFSET_MINUTES) * 60_000).toISOString();
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMidnight(toUtcMidnight(date) + days * DAY_MS);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtcMidnight(b) - toUtcMidnight(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: IsoDate): number {
  return new Date(toUtcMidnight(date)).getUTCDay();
}

/** The week containing `date`, as [start, end) with `weekStart` 0 (일) or 1 (월) etc. */
export function weekRange(date: IsoDate, weekStart: number): { start: IsoDate; end: IsoDate } {
  const back = (dayOfWeek(date) - weekStart + 7) % 7;
  const start = addDays(date, -back);
  return { start, end: addDays(start, 7) };
}

export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'] as const;

export function weekdayKo(date: IsoDate): string {
  return WEEKDAYS_KO[dayOfWeek(date)] ?? '';
}

/** `10월 19일 (월)` */
export function formatDateKo(date: IsoDate, withWeekday = true): string {
  const [, m, d] = date.split('-').map(Number);
  return withWeekday ? `${m}월 ${d}일 (${weekdayKo(date)})` : `${m}월 ${d}일`;
}

/** Short table format `10.19` (adds the year when it differs from `today`). */
export function formatDateShort(date: IsoDate, today?: IsoDate): string {
  const [y, m, d] = date.split('-');
  const md = `${m}.${d}`;
  return today && today.slice(0, 4) !== y ? `${y}.${md}` : md;
}

/** `2026. 10. 19. 14:30` in KST. */
export function formatInstantKo(instant: IsoInstant, hour24 = true): string {
  const date = kstDateOf(instant);
  const time = kstTimeOf(instant);
  return `${date.replaceAll('-', '. ')}. ${hour24 ? time : to12h(time)}`;
}

export function to12h(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const suffix = h < 12 ? '오전' : '오후';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${suffix} ${hh}:${String(m).padStart(2, '0')}`;
}
