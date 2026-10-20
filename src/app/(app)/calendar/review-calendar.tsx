'use client';

import type {
  DatesSetArg,
  EventApi,
  EventClickArg,
  EventContentArg,
  EventDropArg,
  EventInput,
  EventSourceFuncArg,
} from '@fullcalendar/core';
import koLocale from '@fullcalendar/core/locales/ko';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin, { type DateClickArg, type EventResizeDoneArg } from '@fullcalendar/interaction';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dot, OverdueTag } from '@/components/badges';
import { IconChevronLeft, IconChevronRight } from '@/components/icons';
import { PeekLink } from '@/components/peek-link';
import { OPS_EVENTS, useShell } from '@/components/shell-context';
import { useToast } from '@/components/toast';
import { useView } from '@/components/views/view-context';
import { formatDateKo, kstDateOf, kstTimeOf, type IsoDate } from '@/lib/domain/dates';
import { CALENDAR_FIELD_META, CALENDAR_FIELDS, type CalendarField } from '@/lib/domain/review';
import type { FilterRoot } from '@/lib/view-config';
import { calendarChipsAction, moveReviewDateAction } from '@/server/actions/reviews';
import { updateSettingsAction } from '@/server/actions/settings';
import type { CalendarChip } from '@/server/db/calendar';
import type { UserSettings } from '@/server/db/settings';

/*
 * Time zone: FullCalendar's standard plugins only know "local" and "UTC". We run it in
 * UTC mode and feed it KST wall-clock values (Korea has no DST), so the grid shows Seoul
 * time on any machine; reading event.start.toISOString() gives the KST date/time back.
 */
const KST_OFFSET_MS = 9 * 3_600_000;
const kstWall = (instant: string) => `${kstDateOf(instant)}T${kstTimeOf(instant)}:00`;
const nowAsKstWall = () => new Date(Date.now() + KST_OFFSET_MS);

const ZOOM_STEPS = ['1.5rem', '2rem', '2.75rem', '3.75rem'];
type View = 'month' | 'week';
const FC_VIEW: Record<View, string> = { month: 'dayGridMonth', week: 'timeGridWeek' };

function toEvent(chip: CalendarChip): EventInput {
  const meta = CALENDAR_FIELD_META[chip.field];
  return {
    id: `${chip.reviewId}:${chip.field}`,
    title: chip.productName,
    start: chip.startsAt ? kstWall(chip.startsAt) : chip.date,
    end: chip.endsAt ? kstWall(chip.endsAt) : undefined,
    allDay: !chip.startsAt,
    durationEditable: chip.field === 'shoot' && chip.startsAt !== null,
    // only timed blocks in the week grid get a colored edge; day chips stay borderless
    borderColor: chip.startsAt ? (chip.overdue ? 'var(--danger)' : meta.color) : undefined,
    classNames: chip.overdue ? ['is-overdue'] : [],
    extendedProps: { chip },
  };
}

function ChipContent({ arg }: { arg: EventContentArg }) {
  const chip = arg.event.extendedProps.chip as CalendarChip;
  const meta = CALENDAR_FIELD_META[chip.field];
  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 overflow-hidden px-1 py-px ${chip.overdue ? 'font-medium text-danger' : ''}`}
      data-review-id={chip.reviewId}
      data-field={chip.field}
      title={`${meta.label}: ${chip.productName}${chip.brandName ? ` (${chip.brandName})` : ''}${chip.overdue ? ' · 지연' : ''}`}
    >
      <Dot color={chip.overdue ? 'var(--danger)' : meta.color} className="size-1.5" />
      {arg.timeText ? <span className="ops-chip-text shrink-0 text-muted">{arg.timeText}</span> : null}
      <span className="ops-chip-text truncate">{chip.productName}</span>
      <span className="sr-only">
        {meta.label}
        {chip.overdue ? ', 지연' : ''}
      </span>
    </div>
  );
}

export function ReviewCalendar({
  settings,
  today,
  initialDate,
  initialView,
}: {
  settings: UserSettings;
  today: IsoDate;
  initialDate: IsoDate;
  initialView: View;
}) {
  const toast = useToast();
  const { openQuickCreate, openPeek } = useShell();
  const calendarRef = useRef<FullCalendar>(null);
  const [title, setTitle] = useState('');
  const [view, setView] = useState<View>(initialView);
  // The plotted date fields and the filter belong to the open saved view (toggling a field is a view edit).
  const { config, update } = useView();
  const fieldsKey = config.calendarFields.join(',');
  const filterKey = JSON.stringify(config.filter);
  const fields = useMemo(() => (fieldsKey ? (fieldsKey.split(',') as CalendarField[]) : []), [fieldsKey]);
  const filter = useMemo(() => JSON.parse(filterKey) as FilterRoot, [filterKey]);
  const [weekStart, setWeekStart] = useState(settings.weekStart);
  const [showWeekends, setShowWeekends] = useState(settings.showWeekends);
  const [hour24, setHour24] = useState(settings.timeFormat24h);
  const [zoom, setZoom] = useState(1);
  const [agenda, setAgenda] = useState<CalendarChip[]>([]);
  const [range, setRange] = useState<{ start: IsoDate; end: IsoDate } | null>(null);

  const api = useCallback(() => calendarRef.current?.getApi(), []);

  const persist = useCallback(
    async (patch: Partial<UserSettings>) => {
      const result = await updateSettingsAction(patch);
      if (!result.ok) toast(result.error, { tone: 'error' });
    },
    [toast],
  );

  // A new function identity makes FullCalendar refetch, so toggling a field or editing the filter reloads chips.
  const fetchEvents = useCallback(
    (info: EventSourceFuncArg, success: (events: EventInput[]) => void, failure: (error: Error) => void) => {
      calendarChipsAction({ from: info.startStr.slice(0, 10), to: info.endStr.slice(0, 10), fields, filter }).then(
        (result) => (result.ok ? success(result.data.map(toEvent)) : failure(new Error(result.error))),
        failure,
      );
    },
    [fields, filter],
  );

  const switchView = useCallback(
    (next: View) => {
      api()?.changeView(FC_VIEW[next]);
      setView(next);
      void persist({ calendarView: next });
    },
    [api, persist],
  );

  // Keyboard: ←/→ navigate, M/W switch view, +/- zoom hours, T (from the shell) = today.
  useEffect(() => {
    const onToday = () => api()?.today();
    const onChanged = () => api()?.refetchEvents();
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'ArrowLeft' || e.key === 'j') api()?.prev();
      else if (e.key === 'ArrowRight' || e.key === 'k') api()?.next();
      else if (e.key === 'm' || e.key === 'ㅡ') switchView('month');
      else if (e.key === 'w' || e.key === 'ㅈ') switchView('week');
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(z + 1, ZOOM_STEPS.length - 1));
      else if (e.key === '-') setZoom((z) => Math.max(z - 1, 0));
    }
    window.addEventListener(OPS_EVENTS.calendarToday, onToday);
    window.addEventListener(OPS_EVENTS.reviewsChanged, onChanged);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener(OPS_EVENTS.calendarToday, onToday);
      window.removeEventListener(OPS_EVENTS.reviewsChanged, onChanged);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [api, switchView]);

  async function saveMove(event: EventApi, revert: () => void) {
    const chip = event.extendedProps.chip as CalendarChip;
    const start = event.start!.toISOString();
    const timed = !event.allDay;
    const result = await moveReviewDateAction({
      reviewId: chip.reviewId,
      field: chip.field,
      date: start.slice(0, 10),
      startTime: timed ? start.slice(11, 16) : null,
      endTime: timed && event.end ? event.end.toISOString().slice(11, 16) : null,
    });
    if (!result.ok) {
      revert();
      toast(result.error, { tone: 'error' });
      return;
    }
    api()?.refetchEvents();
    toast(`${CALENDAR_FIELD_META[chip.field].label} 날짜를 ${formatDateKo(start.slice(0, 10))}로 옮겼습니다.`);
  }

  function toggleField(field: CalendarField) {
    const next = fields.includes(field) ? fields.filter((f) => f !== field) : CALENDAR_FIELDS.filter((f) => f === field || fields.includes(f));
    update({ ...config, calendarFields: next });
  }

  return (
    <div className="ops-calendar" style={{ '--ops-slot-h': ZOOM_STEPS[zoom] } as React.CSSProperties}>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="min-w-[10rem] text-[22px] font-bold tracking-tight" aria-live="polite">
          {title}
        </h1>
        <div className="flex items-center gap-1">
          <button type="button" className="btn btn-ghost px-2" aria-label="이전" onClick={() => api()?.prev()}>
            <IconChevronLeft />
          </button>
          <button type="button" className="btn" onClick={() => api()?.today()}>
            오늘
          </button>
          <button type="button" className="btn btn-ghost px-2" aria-label="다음" onClick={() => api()?.next()}>
            <IconChevronRight />
          </button>
        </div>
        <div role="group" aria-label="보기" className="inline-flex rounded-md border border-line p-0.5">
          {(['month', 'week'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className={`h-8 rounded px-3 text-[13px] ${view === v ? 'bg-hover font-semibold' : 'text-muted'}`}
              onClick={() => switchView(v)}
            >
              {v === 'month' ? '월' : '주'}
            </button>
          ))}
        </div>
        <details className="relative">
          <summary className="btn cursor-pointer list-none text-muted">보기 설정</summary>
          <div className="absolute right-0 z-20 mt-1 flex w-56 flex-col gap-3 rounded-lg border border-line-strong bg-bg p-3 text-[13px] sm:left-0 sm:right-auto">
            <fieldset>
              <legend className="label">주 시작</legend>
              <div className="flex gap-3">
                {[
                  [1, '월요일'],
                  [0, '일요일'],
                ].map(([value, label]) => (
                  <label key={value} className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="cal-week-start"
                      checked={weekStart === value}
                      onChange={() => {
                        setWeekStart(value as number);
                        void persist({ weekStart: value as number });
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={showWeekends}
                onChange={(e) => {
                  setShowWeekends(e.target.checked);
                  void persist({ showWeekends: e.target.checked });
                }}
              />
              주말 표시
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hour24}
                onChange={(e) => {
                  setHour24(e.target.checked);
                  void persist({ timeFormat24h: e.target.checked });
                }}
              />
              24시간제
            </label>
          </div>
        </details>
        <div role="group" aria-label="표시할 날짜" className="flex flex-wrap items-center gap-1 lg:ml-auto">
          {CALENDAR_FIELDS.map((field) => {
            const on = fields.includes(field);
            const meta = CALENDAR_FIELD_META[field];
            return (
              <button
                key={field}
                type="button"
                aria-pressed={on}
                data-field-toggle={field}
                onClick={() => toggleField(field)}
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors ${
                  on ? 'border-line-strong text-fg' : 'border-line text-subtle line-through decoration-subtle/60'
                }`}
              >
                <Dot color={on ? meta.color : 'var(--subtle)'} />
                {meta.label}
              </button>
            );
          })}
        </div>
      </div>

      <FullCalendar
        ref={calendarRef}
        plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
        initialView={FC_VIEW[initialView]}
        initialDate={initialDate}
        timeZone="UTC"
        now={nowAsKstWall}
        locale={koLocale}
        headerToolbar={false}
        firstDay={weekStart}
        weekends={showWeekends}
        height={view === 'week' ? 760 : 'auto'}
        fixedWeekCount={false}
        dayMaxEvents={4}
        allDayText="종일"
        nowIndicator
        scrollTime="08:00:00"
        editable
        eventStartEditable
        eventDurationEditable={false}
        eventAllow={(drop, dragged) => (dragged?.extendedProps.chip as CalendarChip).field === 'shoot' || drop.allDay}
        eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: !hour24 }}
        slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: !hour24 }}
        events={fetchEvents}
        eventContent={(arg) => <ChipContent arg={arg} />}
        eventDrop={(info: EventDropArg) => void saveMove(info.event, info.revert)}
        eventResize={(info: EventResizeDoneArg) => void saveMove(info.event, info.revert)}
        // a click (never a drag: FullCalendar does not report one after a drag) opens the quick-edit peek
        eventClick={(info: EventClickArg) => {
          info.jsEvent.preventDefault();
          const chip = info.event.extendedProps.chip as CalendarChip;
          // after a save the chips are re-rendered, so find the chip again to give focus back
          const again = `.fc-event:has([data-review-id="${chip.reviewId}"][data-field="${chip.field}"])`;
          openPeek(chip.reviewId, () => (info.el.isConnected ? info.el : document.querySelector<HTMLElement>(again)));
        }}
        dateClick={(info: DateClickArg) =>
          openQuickCreate({ anchorField: 'shoot', anchorDate: info.dateStr.slice(0, 10) })
        }
        datesSet={(arg: DatesSetArg) => {
          setTitle(arg.view.title);
          setRange({ start: arg.startStr.slice(0, 10), end: arg.endStr.slice(0, 10) });
        }}
        eventsSet={(events) =>
          setAgenda(
            events
              .map((e) => e.extendedProps.chip as CalendarChip)
              .sort((a, b) => a.date.localeCompare(b.date) || (a.startsAt ?? '').localeCompare(b.startsAt ?? '')),
          )
        }
      />
      <p className="mt-3 hidden text-[12px] text-subtle md:block">
        날짜를 클릭하면 새 리뷰, 칩을 클릭하면 빠른 편집, 칩을 끌면 그 날짜만 바뀝니다. 오늘: {formatDateKo(today)}
      </p>
      <Agenda
        // when today is on screen, the list starts there; otherwise it covers the whole view
        chips={range && today >= range.start && today < range.end ? agenda.filter((c) => c.date >= today) : agenda}
        today={today}
      />
    </div>
  );
}

/** Phone view: the grid shows dots, this list carries the names (grouped by day). */
function Agenda({ chips, today }: { chips: CalendarChip[]; today: IsoDate }) {
  const days = [...new Set(chips.map((c) => c.date))];
  if (days.length === 0) return null;
  return (
    <section aria-label="일정 목록" className="mt-6 md:hidden">
      {days.map((day) => (
        <div key={day} className="border-t border-line py-2.5">
          <h2 className={`mb-1 text-[12px] ${day === today ? 'font-bold text-accent' : 'text-muted'}`}>
            {formatDateKo(day)}
            {day === today ? ' · 오늘' : ''}
          </h2>
          <ul>
            {chips
              .filter((c) => c.date === day)
              .map((c) => {
                const meta = CALENDAR_FIELD_META[c.field];
                return (
                  <li key={`${c.reviewId}-${c.field}`}>
                    <PeekLink
                      reviewId={c.reviewId}
                      className={`flex items-center gap-2 py-1 text-[13px] ${c.overdue ? 'text-danger' : ''}`}
                    >
                      <Dot color={c.overdue ? 'var(--danger)' : meta.color} className="size-1.5" />
                      <span className="w-14 shrink-0 text-[12px] text-muted">
                        {c.startsAt ? kstTimeOf(c.startsAt) : meta.label}
                      </span>
                      <span className="truncate">{c.productName}</span>
                      {c.overdue ? <OverdueTag /> : null}
                    </PeekLink>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </section>
  );
}
