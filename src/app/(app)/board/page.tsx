import type { Metadata } from 'next';
import { NewReviewButton } from '@/components/new-review-button';
import { PageHeader } from '@/components/page-header';
import { ViewProvider } from '@/components/views/view-context';
import { ViewToolbar } from '@/components/views/view-toolbar';
import { todayInSeoul } from '@/lib/domain/dates';
import { requireSession } from '@/server/auth/session';
import { getPool } from '@/server/db/pool';
import { listReviewsForView } from '@/server/db/reviews';
import { loadStages } from '@/server/queries';
import { resolveView, runViewQuery } from '@/server/views';
import { Board } from './board';

export const metadata: Metadata = { title: '보드' };

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const requested = await resolveView('board', await searchParams);
  const today = todayInSeoul();
  const [stages, { resolved, result: reviews }] = await Promise.all([
    loadStages(),
    // a config that cannot run falls back to the saved / default settings with a notice
    runViewQuery(requested, (config) => listReviewsForView(getPool(), config, { today })),
  ]);
  return (
    <ViewProvider {...resolved}>
      <PageHeader
        title="보드"
        meta={resolved.effective.groupBy === 'stage' ? '카드를 끌어서 단계를 바꿉니다' : `${reviews.length}개`}
        actions={<NewReviewButton />}
      />
      <ViewToolbar />
      <Board stages={stages} reviews={reviews} today={today} />
    </ViewProvider>
  );
}
