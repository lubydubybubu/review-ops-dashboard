import type { Metadata } from 'next';
import { isIsoDate, todayInSeoul } from '@/lib/domain/dates';
import { loadSettings } from '@/server/queries';
import { ReviewCalendar } from './review-calendar';

export const metadata: Metadata = { title: '캘린더' };

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; view?: string }>;
}) {
  const { date, view } = await searchParams;
  const settings = await loadSettings();
  const today = todayInSeoul();
  return (
    <ReviewCalendar
      // a new ?date= (palette "go to date") re-initialises the calendar there
      key={`${date ?? ''}|${view ?? ''}`}
      settings={settings}
      today={today}
      initialDate={date && isIsoDate(date) ? date : today}
      initialView={view === 'week' || view === 'month' ? view : settings.calendarView}
    />
  );
}
