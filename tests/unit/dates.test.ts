import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfWeek,
  diffDays,
  formatDateKo,
  isIsoDate,
  kstDateOf,
  kstInstant,
  kstTimeOf,
  to12h,
  weekRange,
} from '../../src/lib/domain/dates';
import { parseDateQuery } from '../../src/lib/domain/date-query';

describe('KST date helpers', () => {
  it('validates real calendar dates only', () => {
    expect(isIsoDate('2026-10-19')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-1-01')).toBe(false);
  });

  it('converts between KST wall time and UTC instants', () => {
    expect(kstInstant('2026-10-19', '00:00')).toBe('2026-10-18T15:00:00.000Z');
    expect(kstInstant('2026-10-19', '23:30')).toBe('2026-10-19T14:30:00.000Z');
    expect(kstDateOf('2026-10-18T15:00:00.000Z')).toBe('2026-10-19');
    expect(kstDateOf('2026-10-18T14:59:59.999Z')).toBe('2026-10-18');
    expect(kstTimeOf('2026-10-19T05:00:00.000Z')).toBe('14:00');
  });

  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-10-19', '2026-11-02')).toBe(14);
  });

  it('computes week ranges for Monday and Sunday starts', () => {
    expect(dayOfWeek('2026-10-19')).toBe(1); // Monday
    expect(weekRange('2026-10-21', 1)).toEqual({ start: '2026-10-19', end: '2026-10-26' });
    expect(weekRange('2026-10-21', 0)).toEqual({ start: '2026-10-18', end: '2026-10-25' });
    expect(weekRange('2026-10-18', 1)).toEqual({ start: '2026-10-12', end: '2026-10-19' });
  });

  it('formats in Korean', () => {
    expect(formatDateKo('2026-10-19')).toBe('10월 19일 (월)');
    expect(to12h('00:05')).toBe('오전 12:05');
    expect(to12h('13:30')).toBe('오후 1:30');
  });
});

describe('command palette date parsing', () => {
  const today = '2026-10-19';

  it.each([
    ['오늘', '2026-10-19'],
    ['내일', '2026-10-20'],
    ['모레', '2026-10-21'],
    ['어제', '2026-10-18'],
    ['+10', '2026-10-29'],
    ['-19', '2026-09-30'],
    ['2026-11-03', '2026-11-03'],
    ['2026.11.3', '2026-11-03'],
    ['2027/1/5', '2027-01-05'],
    ['11/3', '2026-11-03'],
    ['11.3', '2026-11-03'],
    ['11월 3일', '2026-11-03'],
    ['11월3일', '2026-11-03'],
    ['2027년 1월 2일', '2027-01-02'],
    ['25일', '2026-10-25'],
  ])('%s → %s', (input, expected) => {
    expect(parseDateQuery(input, today)).toBe(expected);
  });

  it.each(['', 'Northwind', '2026-02-30', '13/1', '키보드 11', '32일'])('%s is not a date', (input) => {
    expect(parseDateQuery(input, today)).toBeNull();
  });
});
