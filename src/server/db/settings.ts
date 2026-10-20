import type { CalendarField } from '@/lib/domain/review';
import type { SettingsInput } from '@/lib/validation';
import type { Queryable } from './client';

export type Theme = 'system' | 'light' | 'dark';

export interface UserSettings {
  weekStart: number;
  showWeekends: boolean;
  timeFormat24h: boolean;
  theme: Theme;
  calendarFields: CalendarField[];
  calendarView: 'month' | 'week';
}

export const DEFAULT_SETTINGS: UserSettings = {
  weekStart: 1,
  showWeekends: true,
  timeFormat24h: true,
  theme: 'system',
  calendarFields: ['shoot', 'write_due', 'publish_planned', 'embargo'],
  calendarView: 'month',
};

const SELECT = `
  select week_start as "weekStart", show_weekends as "showWeekends", time_format_24h as "timeFormat24h",
         theme, calendar_fields as "calendarFields", calendar_view as "calendarView"
    from user_settings where id = 1`;

export async function getSettings(db: Queryable): Promise<UserSettings> {
  const { rows } = await db.query<UserSettings>(SELECT);
  return rows[0] ?? DEFAULT_SETTINGS;
}

/** Partial update: omitted keys keep their stored value. */
export async function updateSettings(db: Queryable, input: SettingsInput): Promise<UserSettings> {
  const { rows } = await db.query<UserSettings>(
    `update user_settings set
        week_start      = coalesce($1, week_start),
        show_weekends   = coalesce($2, show_weekends),
        time_format_24h = coalesce($3, time_format_24h),
        theme           = coalesce($4, theme),
        calendar_fields = coalesce($5, calendar_fields),
        calendar_view   = coalesce($6, calendar_view)
      where id = 1
      returning week_start as "weekStart", show_weekends as "showWeekends",
                time_format_24h as "timeFormat24h", theme,
                calendar_fields as "calendarFields", calendar_view as "calendarView"`,
    [
      input.weekStart ?? null,
      input.showWeekends ?? null,
      input.timeFormat24h ?? null,
      input.theme ?? null,
      input.calendarFields ?? null,
      input.calendarView ?? null,
    ],
  );
  return rows[0]!;
}
