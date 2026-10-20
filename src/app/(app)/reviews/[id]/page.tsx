import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Dot } from '@/components/badges';
import { formatInstantKo, todayInSeoul } from '@/lib/domain/dates';
import { requireSession } from '@/server/auth/session';
import { listBrandOptions } from '@/server/db/brands';
import { listChecklist } from '@/server/db/checklist';
import { getPool } from '@/server/db/pool';
import { getReview, getStageHistory } from '@/server/db/reviews';
import { loadSettings, loadStages } from '@/server/queries';
import { Checklist } from './checklist';
import { ReviewEditor } from './review-editor';

type Props = { params: Promise<{ id: string }> };

async function load(idParam: string) {
  await requireSession();
  const id = Number(idParam);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const review = await getReview(getPool(), id);
  if (!review) notFound();
  return review;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const review = await load((await params).id);
  return { title: review.productName };
}

export default async function ReviewPage({ params }: Props) {
  const review = await load((await params).id);
  const db = getPool();
  const [stages, brands, history, checklist, settings] = await Promise.all([
    loadStages(),
    listBrandOptions(db),
    getStageHistory(db, review.id),
    listChecklist(db, review.id),
    loadSettings(),
  ]);

  return (
    <div className="mx-auto max-w-6xl">
      <nav aria-label="경로" className="mb-3 text-[12px] text-muted">
        <Link href="/reviews" className="hover:text-fg">
          리뷰
        </Link>
        <span className="mx-1.5 text-subtle">/</span>
        <span>{review.productName}</span>
      </nav>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <ReviewEditor key={review.updatedAt} review={review} stages={stages} brands={brands} today={todayInSeoul()} />

        <aside className="flex flex-col gap-8">
          <Checklist reviewId={review.id} items={checklist} readOnly={review.archivedAt !== null} />

          <section aria-labelledby="history-title">
            <h2 id="history-title" className="section-title">
              단계 이력
            </h2>
            <ol className="relative mt-3 ml-1 border-l border-line">
              {history.map((h) => (
                <li key={h.id} className="relative pb-3 pl-4 text-[13px]">
                  <span className="absolute top-1.5 -left-[4.5px]">
                    <Dot color={h.toStageColor} />
                  </span>
                  <p>
                    {h.fromStageName ? (
                      <>
                        <span className="text-muted">{h.fromStageName}</span> → {h.toStageName}
                      </>
                    ) : (
                      <>{h.toStageName}에서 시작</>
                    )}
                  </p>
                  <p className="text-[12px] text-subtle">
                    <time dateTime={h.changedAt}>{formatInstantKo(h.changedAt, settings.timeFormat24h)}</time>
                  </p>
                </li>
              ))}
            </ol>
          </section>

          <p className="text-[12px] text-subtle">
            만든 날 {formatInstantKo(review.createdAt, settings.timeFormat24h)}
            <br />
            고친 날 {formatInstantKo(review.updatedAt, settings.timeFormat24h)}
          </p>
        </aside>
      </div>
    </div>
  );
}
