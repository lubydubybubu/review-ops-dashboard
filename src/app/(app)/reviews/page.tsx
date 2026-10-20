import type { Metadata } from 'next';
import Link from 'next/link';
import { OverdueTag, StageBadge } from '@/components/badges';
import { NewReviewButton } from '@/components/new-review-button';
import { PageHeader } from '@/components/page-header';
import { formatDateShort, todayInSeoul, type IsoDate } from '@/lib/domain/dates';
import { overdueFields } from '@/lib/domain/overdue';
import { PRIORITY_LABEL, SOURCE_TYPE_LABEL, type CalendarField } from '@/lib/domain/review';
import { filterHref, parseFilterParams, type ReviewFilterParams } from '@/lib/review-filter';
import { requireSession } from '@/server/auth/session';
import { listBrandOptions } from '@/server/db/brands';
import { getPool } from '@/server/db/pool';
import { listReviews, type ReviewListItem } from '@/server/db/reviews';
import { loadStages } from '@/server/queries';
import { ReviewFilters } from './review-filters';

export const metadata: Metadata = { title: '리뷰 표' };

type SortKey = NonNullable<ReviewFilterParams['sort']>;

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'product', label: '제품' },
  { key: 'brand', label: '브랜드' },
  { key: 'stage', label: '단계' },
  { key: 'received', label: '입고', className: 'w-20' },
  { key: 'shoot', label: '촬영', className: 'w-20' },
  { key: 'write_due', label: '작성 마감', className: 'w-24' },
  { key: 'publish_planned', label: '발행 예정', className: 'w-24' },
  { key: 'priority', label: '우선순위', className: 'w-20' },
];

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const params = parseFilterParams(await searchParams);
  const db = getPool();
  const today = todayInSeoul();
  const [stages, brands, reviews] = await Promise.all([
    loadStages(),
    listBrandOptions(db),
    listReviews(db, {
      q: params.q,
      stageId: params.stage,
      category: params.category,
      brandId: params.brand,
      dateField: params.field,
      from: params.from,
      to: params.to,
      archived: params.archived === '1',
      sort: params.sort,
      dir: params.dir,
    }),
  ]);

  return (
    <>
      <PageHeader
        title="리뷰 표"
        meta={`${reviews.length}개${params.archived ? ' · 보관함' : ''}`}
        actions={<NewReviewButton />}
      />
      <ReviewFilters params={params} stages={stages} brands={brands} />

      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
        <table className="w-full min-w-[54rem] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-line-strong">
              {COLUMNS.map((col) => {
                const active = params.sort === col.key;
                const nextDir = active && params.dir !== 'desc' ? 'desc' : 'asc';
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={active ? (params.dir === 'desc' ? 'descending' : 'ascending') : undefined}
                    className={`py-2 pr-3 text-[12px] font-medium text-muted ${col.className ?? ''}`}
                  >
                    <Link href={filterHref(params, { sort: col.key, dir: nextDir })} className="inline-flex items-center gap-1 hover:text-fg">
                      {col.label}
                      <span aria-hidden className={active ? 'text-accent' : 'invisible'}>
                        {params.dir === 'desc' ? '↓' : '↑'}
                      </span>
                    </Link>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {reviews.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length} className="py-10 text-center text-muted">
                  조건에 맞는 리뷰가 없습니다.
                </td>
              </tr>
            ) : (
              reviews.map((r) => <Row key={r.id} review={r} today={today} />)
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Row({ review: r, today }: { review: ReviewListItem; today: IsoDate }) {
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
        <Link href={`/reviews/${r.id}`} className="font-medium hover:underline hover:underline-offset-2">
          {r.productName}
        </Link>
        <span className="ml-2 inline-flex gap-1.5 align-middle">
          {r.sourceType ? <span className="text-[11px] text-subtle">{SOURCE_TYPE_LABEL[r.sourceType]}</span> : null}
          {late.size > 0 ? <OverdueTag /> : null}
        </span>
      </td>
      <td className="py-2 pr-3 text-muted">{r.brandName ?? '—'}</td>
      <td className="py-2 pr-3">
        <StageBadge name={r.stageName} color={r.stageColor} onHold={r.isOnHold} />
      </td>
      <td className="py-2 pr-3 tabular-nums">{date(r.receivedOn)}</td>
      <td className="py-2 pr-3 tabular-nums">{date(r.shootOn)}</td>
      <td className="py-2 pr-3 tabular-nums">{date(r.writeDueOn, 'write_due')}</td>
      <td className="py-2 pr-3 tabular-nums">{date(r.publishPlannedOn, 'publish_planned')}</td>
      <td className={`py-2 pr-3 ${r.priority === 'high' ? 'font-medium text-accent' : 'text-muted'}`}>
        {PRIORITY_LABEL[r.priority]}
      </td>
    </tr>
  );
}
