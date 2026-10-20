import { addDays, isIsoDate, type IsoDate } from './dates';

const RELATIVE: Record<string, number> = { 어제: -1, 오늘: 0, 내일: 1, 모레: 2, 글피: 3 };

function build(year: number, month: number, day: number): IsoDate | null {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * Parse what the owner types into the command palette as a date ("go to date").
 * Accepts 오늘/내일/모레/어제, `2026-11-03`, `2026.11.3`, `11/3`, `11.3`, `11월 3일`,
 * `3일` (this month) and `+3` / `-2` (days from today). Returns null when it is not a date.
 */
export function parseDateQuery(input: string, today: IsoDate): IsoDate | null {
  const q = input.trim().replace(/\s+/g, ' ');
  if (!q) return null;

  if (q in RELATIVE) return addDays(today, RELATIVE[q]!);

  let m = /^([+-])(\d{1,3})$/.exec(q);
  if (m) return addDays(today, (m[1] === '-' ? -1 : 1) * Number(m[2]));

  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  m = /^(\d{4})[-./ ](\d{1,2})[-./ ](\d{1,2})\.?$/.exec(q);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{4})년 ?(\d{1,2})월 ?(\d{1,2})일$/.exec(q);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})[./-](\d{1,2})\.?$/.exec(q) ?? /^(\d{1,2})월 ?(\d{1,2})일$/.exec(q);
  if (m) return build(year, Number(m[1]), Number(m[2]));

  m = /^(\d{1,2})일$/.exec(q);
  if (m) return build(year, month, Number(m[1]));

  return null;
}
