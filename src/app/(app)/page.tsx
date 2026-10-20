import type { Metadata } from 'next';
import Link from 'next/link';
import { Dot, OverdueTag, StageBadge } from '@/components/badges';
import { NewReviewButton } from '@/components/new-review-button';
import { PeekLink } from '@/components/peek-link';
import { PageHeader } from '@/components/page-header';
import { addDays, dayOfWeek, diffDays, formatDateKo, formatDateShort, kstTimeOf, todayInSeoul, weekRange, weekdayKo } from '@/lib/domain/dates';
import { overdueFields } from '@/lib/domain/overdue';
import { CALENDAR_FIELD_META, CATEGORY_KEYS, CATEGORY_LABEL } from '@/lib/domain/review';
import { requireSession } from '@/server/auth/session';
import { listCalendarChips } from '@/server/db/calendar';
import { countReviewsByStage, listOverdueReviews } from '@/server/db/dashboard';
import { getPool } from '@/server/db/pool';
import { loadSettings, loadStages } from '@/server/queries';

export const metadata: Metadata = { title: '대시보드' };

export default async function DashboardPage() {
  await requireSession();
  const db = getPool();
  const today = todayInSeoul();
  const settings = await loadSettings();
  const week = weekRange(today, settings.weekStart);
  const [stages, overdue, counts, chips] = await Promise.all([
    loadStages(),
    listOverdueReviews(db, today),
    countReviewsByStage(db),
    listCalendarChips(db, { from: week.start, to: week.end, fields: settings.calendarFields }, today),
  ]);

  const countByStage = new Map(counts.map((c) => [c.stageId, c.count]));
  const active = stages
    .filter((s) => s.categoryKey !== 'done')
    .reduce((sum, s) => sum + (countByStage.get(s.id) ?? 0), 0);
  const maxCount = Math.max(1, ...counts.map((c) => c.count));
  const dueThisWeek = chips.filter((c) => CALENDAR_FIELD_META[c.field].isDeadline && c.date >= today).length;

  const days = Array.from({ length: 7 }, (_, i) => addDays(week.start, i)).filter(
    (d) => settings.showWeekends || ![0, 6].includes(dayOfWeek(d)),
  );

  return (
    <>
      <PageHeader title="대시보드" meta={formatDateKo(today)} actions={<NewReviewButton />} />

      <dl className="mb-10 grid grid-cols-3 divide-x divide-line border-y border-line">
        <Stat label="지연" value={overdue.length} danger={overdue.length > 0} />
        <Stat label="이번 주 남은 마감" value={dueThisWeek} />
        <Stat label="진행 중인 리뷰" value={active} />
      </dl>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section aria-labelledby="overdue-title">
          <h2 id="overdue-title" className="section-title">
            지연된 리뷰
            <span className="text-[12px] font-normal text-muted">{overdue.length}개</span>
          </h2>
          {overdue.length === 0 ? (
            <p className="py-6 text-[13px] text-muted">지연된 리뷰가 없습니다.</p>
          ) : (
            <ul className="divide-y divide-line">
              {overdue.map((r) => (
                <li key={r.id}>
                  <PeekLink reviewId={r.id} className="-mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2.5 hover:bg-hover">
                    <span className="min-w-0 flex-1 truncate font-medium">{r.productName}</span>
                    <StageBadge name={r.stageName} color={r.stageColor} />
                    <span className="flex w-full flex-wrap gap-2 text-[12px] text-danger sm:w-auto">
                      {overdueFields(r, today).map((field) => {
                        const date = field === 'write_due' ? r.writeDueOn! : r.publishPlannedOn!;
                        return (
                          <span key={field} className="whitespace-nowrap">
                            {CALENDAR_FIELD_META[field].label} {formatDateShort(date, today)} · {diffDays(date, today)}일 지남
                          </span>
                        );
                      })}
                    </span>
                  </PeekLink>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="stages-title">
          <h2 id="stages-title" className="section-title">
            단계별 현황
            <Link href="/board" className="text-[12px] font-normal text-muted hover:text-fg">
              보드 열기
            </Link>
          </h2>
          <div className="flex flex-col gap-4 pt-3">
            {CATEGORY_KEYS.map((category) => (
              <div key={category}>
                <p className="mb-1 text-[11px] font-medium text-subtle">{CATEGORY_LABEL[category]}</p>
                <ul>
                  {stages
                    .filter((s) => s.categoryKey === category)
                    .map((s) => {
                      const n = countByStage.get(s.id) ?? 0;
                      return (
                        <li key={s.id}>
                          <Link href={`/reviews?stage=${s.id}`} className="-mx-2 grid grid-cols-[7rem_1fr_2rem] items-center gap-3 rounded-md px-2 py-1 hover:bg-hover">
                            <StageBadge name={s.name} color={s.color} onHold={s.isOnHold} />
                            <span className="h-[3px] rounded-full bg-line">
                              <span
                                className="block h-full rounded-full"
                                style={{ width: `${(n / maxCount) * 100}%`, background: s.color }}
                              />
                            </span>
                            <span className="text-right text-[13px] tabular-nums">{n}</span>
                          </Link>
                        </li>
                      );
                    })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section aria-labelledby="week-title" className="mt-10">
        <h2 id="week-title" className="section-title">
          이번 주
          <Link href={`/calendar?date=${today}&view=week`} className="text-[12px] font-normal text-muted hover:text-fg">
            캘린더에서 보기
          </Link>
        </h2>
        <ol className="grid divide-y divide-line md:grid-cols-[repeat(var(--days),minmax(0,1fr))] md:divide-x md:divide-y-0" style={{ '--days': days.length } as React.CSSProperties}>
          {days.map((day) => {
            const dayChips = chips.filter((c) => c.date === day);
            const isToday = day === today;
            return (
              <li key={day} className="min-h-24 py-3 md:px-2.5 md:first:pl-0">
                <p className={`mb-2 text-[12px] ${isToday ? 'font-bold text-accent' : 'text-muted'}`}>
                  {weekdayKo(day)} {Number(day.slice(8))}
                  {isToday ? ' · 오늘' : ''}
                </p>
                <ul className="flex flex-col gap-1">
                  {dayChips.map((c) => (
                    <li key={`${c.reviewId}-${c.field}`}>
                      <PeekLink
                        reviewId={c.reviewId}
                        className={`flex items-center gap-1.5 rounded px-1 py-0.5 text-[12px] hover:bg-hover ${c.overdue ? 'bg-danger-soft text-danger' : ''}`}
                        title={`${CALENDAR_FIELD_META[c.field].label}: ${c.productName}`}
                      >
                        <Dot color={c.overdue ? 'var(--danger)' : CALENDAR_FIELD_META[c.field].color} className="size-1.5" />
                        <span className="shrink-0 text-muted">
                          {c.startsAt ? kstTimeOf(c.startsAt) : CALENDAR_FIELD_META[c.field].label}
                        </span>
                        <span className="truncate">{c.productName}</span>
                        {c.overdue ? <OverdueTag /> : null}
                      </PeekLink>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

function Stat({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="px-3 py-3 first:pl-0 sm:px-5">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className={`text-[24px] font-semibold tabular-nums tracking-tight ${danger ? 'text-danger' : ''}`}>{value}</dd>
    </div>
  );
}
