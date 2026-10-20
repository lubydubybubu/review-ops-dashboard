import type { Metadata } from 'next';
import { ViewProvider } from '@/components/views/view-context';
import { ViewToolbar } from '@/components/views/view-toolbar';
import { isIsoDate, todayInSeoul } from '@/lib/domain/dates';
import { requireSession } from '@/server/auth/session';
import { loadSettings } from '@/server/queries';
import { resolveView } from '@/server/views';
import { ReviewCalendar } from './review-calendar';

export const metadata: Metadata = { title: '캘린더' };

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const sp = await searchParams;
  const date = typeof sp.date === 'string' ? sp.date : undefined;
  const view = typeof sp.view === 'string' ? sp.view : undefined;
  const [settings, resolved] = await Promise.all([loadSettings(), resolveView('calendar', sp)]);
  const today = todayInSeoul();
  return (
    <ViewProvider {...resolved}>
      <ViewToolbar />
      <ReviewCalendar
        // a new ?date= (palette "go to date") re-initialises the calendar there
        key={`${date ?? ''}|${view ?? ''}`}
        settings={settings}
        today={today}
        initialDate={date && isIsoDate(date) ? date : today}
        initialView={view === 'week' || view === 'month' ? view : settings.calendarView}
      />
    </ViewProvider>
  );
}
