import type { Metadata } from 'next';
import Link from 'next/link';
import { Dot, OverdueTag, StageBadge } from '@/components/badges';
import { NewReviewButton } from '@/components/new-review-button';
import { PageHeader } from '@/components/page-header';
import { ViewProvider } from '@/components/views/view-context';
import { ViewToolbar } from '@/components/views/view-toolbar';
import { formatDateShort, todayInSeoul, type IsoDate } from '@/lib/domain/dates';
import { overdueFields } from '@/lib/domain/overdue';
import { CHANNEL_LABEL, PRIORITY_LABEL, SOURCE_TYPE_LABEL, type CalendarField } from '@/lib/domain/review';
import { groupReviews } from '@/lib/view-groups';
import { sameConfig, viewHref, type PropertyKey, type SortProp, type ViewConfig } from '@/lib/views';
import { requireSession } from '@/server/auth/session';
import { getPool } from '@/server/db/pool';
import { listReviewsForView, VIEW_ROW_LIMIT, type ReviewListItem } from '@/server/db/reviews';
import { loadStages } from '@/server/queries';
import { resolveView, runViewQuery } from '@/server/views';

export const metadata: Metadata = { title: '리뷰 표' };

interface Column {
  /** null = always shown (제품) */
  prop: PropertyKey | null;
  sort: SortProp | null;
  label: string;
  className?: string;
}

const COLUMNS: Column[] = [
  { prop: null, sort: 'product', label: '제품' },
  { prop: 'brand', sort: 'brand', label: '브랜드' },
  { prop: 'stage', sort: 'stage', label: '단계' },
  { prop: 'received', sort: 'received', label: '입고', className: 'w-20' },
  { prop: 'shoot', sort: 'shoot', label: '촬영', className: 'w-20' },
  { prop: 'write_due', sort: 'write_due', label: '작성 마감', className: 'w-24' },
  { prop: 'publish_planned', sort: 'publish_planned', label: '발행 예정', className: 'w-24' },
  { prop: 'embargo', sort: 'embargo', label: '엠바고', className: 'w-20' },
  { prop: 'priority', sort: 'priority', label: '우선순위', className: 'w-20' },
  { prop: 'channels', sort: null, label: '채널' },
];

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const sp = await searchParams;
  const archived = sp.archived === '1';
  const requested = await resolveView('list', sp);
  const today = todayInSeoul();
  const [stages, { resolved, result: reviews }] = await Promise.all([
    loadStages(),
    // a config that cannot run falls back to the saved / default settings with a notice
    runViewQuery(requested, (config) => listReviewsForView(getPool(), config, { today, archived })),
  ]);
  const { view, saved, effective: config, base } = resolved;

  const columns = COLUMNS.filter((c) => c.prop === null || !config.hidden.includes(c.prop));
  const visible = new Set(columns.map((c) => c.prop));
  const showSourceType = !config.hidden.includes('source_type');
  /** the same view with `next` settings (unsaved unless equal to the saved ones; a draft keeps its base) */
  const href = (next: ViewConfig, extra: { archived?: string } = { archived: archived ? '1' : undefined }) =>
    viewHref('list', view?.id ?? null, sameConfig(next, saved) ? null : next, extra, base);
  const groups = config.groupBy ? groupReviews(reviews, config.groupBy, stages, { includeEmpty: false }) : null;
  const primary = config.sorts[0];

  return (
    <ViewProvider {...resolved}>
      <PageHeader
        title="리뷰 표"
        meta={`${reviews.length}개${reviews.length >= VIEW_ROW_LIMIT ? ` (최대 ${VIEW_ROW_LIMIT}개까지 표시)` : ''}${archived ? ' · 보관함' : ''}`}
        actions={
          <>
            <Link href={href(config, { archived: archived ? undefined : '1' })} className="btn btn-ghost text-muted">
              {archived ? '진행 목록 보기' : '보관함'}
            </Link>
            <NewReviewButton />
          </>
        }
      />
      <ViewToolbar />

      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <table className="w-full min-w-[54rem] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-line-strong">
              {columns.map((col) => {
                const active = col.sort !== null && primary?.prop === col.sort;
                const label = (
                  <>
                    {col.label}
                    <span aria-hidden className={active ? 'text-accent' : 'invisible'}>
                      {primary?.dir === 'desc' ? '↓' : '↑'}
                    </span>
                  </>
                );
                return (
                  <th
                    key={col.label}
                    scope="col"
                    aria-sort={active ? (primary!.dir === 'desc' ? 'descending' : 'ascending') : undefined}
                    className={`py-2 pr-3 text-[12px] font-medium text-muted ${col.className ?? ''}`}
                  >
                    {col.sort ? (
                      <Link
                        replace
                        scroll={false}
                        href={href({
                          ...config,
                          // header click = primary sort (toggling its direction); other sorts follow
                          sorts: [
                            { prop: col.sort, dir: active && primary!.dir !== 'desc' ? ('desc' as const) : ('asc' as const) },
                            ...config.sorts.filter((s) => s.prop !== col.sort),
                          ].slice(0, 5),
                        })}
                        className="inline-flex items-center gap-1 hover:text-fg"
                      >
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          {reviews.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={columns.length} className="py-10 text-center text-muted">
                  조건에 맞는 리뷰가 없습니다.
                </td>
              </tr>
            </tbody>
          ) : groups ? (
            groups.map((g) => (
              <tbody key={g.key} data-group={g.key}>
                <tr className="border-b border-line">
                  <th scope="colgroup" colSpan={columns.length} className="pt-4 pb-1.5 text-left text-[12px] font-semibold">
                    <span className="inline-flex items-center gap-2">
                      {g.color ? <Dot color={g.color} /> : null}
                      {g.label}
                      <span className="font-normal text-subtle tabular-nums" data-group-count>
                        {g.items.length}
                      </span>
                    </span>
                  </th>
                </tr>
                {g.items.map((r) => (
                  <Row key={r.id} review={r} today={today} visible={visible} showSourceType={showSourceType} />
                ))}
              </tbody>
            ))
          ) : (
            <tbody>
              {reviews.map((r) => (
                <Row key={r.id} review={r} today={today} visible={visible} showSourceType={showSourceType} />
              ))}
            </tbody>
          )}
        </table>
      </div>
    </ViewProvider>
  );
}

function Row({
  review: r,
  today,
  visible,
  showSourceType,
}: {
  review: ReviewListItem;
  today: IsoDate;
  visible: Set<PropertyKey | null>;
  showSourceType: boolean;
}) {
  const late = new Set<CalendarField>(r.archivedAt ? [] : overdueFields(r, today));
  const date = (value: IsoDate | null, field?: CalendarField) =>
    value ? (
      <span className={field && late.has(field) ? 'font-semibold text-danger' : undefined}>
        {formatDateShort(value, today)}
      </span>
    ) : (
      <span className="text-subtle">—</span>
    );

  return (
    <tr className="border-b border-line hover:bg-hover" data-review-id={r.id}>
      <td className="py-2 pr-3">
        {/* no prefetch: up to 500 rows would each prefetch a detail page that is rarely opened */}
        <Link href={`/reviews/${r.id}`} prefetch={false} className="font-medium hover:underline hover:underline-offset-2">
          {r.productName}
        </Link>
        <span className="ml-2 inline-flex gap-1.5 align-middle">
          {showSourceType && r.sourceType ? <span className="text-[11px] text-subtle">{SOURCE_TYPE_LABEL[r.sourceType]}</span> : null}
          {late.size > 0 ? <OverdueTag /> : null}
        </span>
      </td>
      {visible.has('brand') ? <td className="py-2 pr-3 text-muted">{r.brandName ?? '—'}</td> : null}
      {visible.has('stage') ? (
        <td className="py-2 pr-3">
          <StageBadge name={r.stageName} color={r.stageColor} onHold={r.isOnHold} />
        </td>
      ) : null}
      {visible.has('received') ? <td className="py-2 pr-3 tabular-nums">{date(r.receivedOn)}</td> : null}
      {visible.has('shoot') ? <td className="py-2 pr-3 tabular-nums">{date(r.shootOn)}</td> : null}
      {visible.has('write_due') ? <td className="py-2 pr-3 tabular-nums">{date(r.writeDueOn, 'write_due')}</td> : null}
      {visible.has('publish_planned') ? (
        <td className="py-2 pr-3 tabular-nums">{date(r.publishPlannedOn, 'publish_planned')}</td>
      ) : null}
      {visible.has('embargo') ? <td className="py-2 pr-3 tabular-nums">{date(r.embargoUntil)}</td> : null}
      {visible.has('priority') ? (
        <td className={`py-2 pr-3 ${r.priority === 'high' ? 'font-medium text-accent' : 'text-muted'}`}>
          {PRIORITY_LABEL[r.priority]}
        </td>
      ) : null}
      {visible.has('channels') ? (
        <td className="py-2 pr-3 text-[12px] text-muted">{r.channels.map((c) => CHANNEL_LABEL[c]).join(', ') || '—'}</td>
      ) : null}
    </tr>
  );
}
