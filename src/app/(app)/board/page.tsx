import type { Metadata } from 'next';
import { NewReviewButton } from '@/components/new-review-button';
import { PageHeader } from '@/components/page-header';
import { todayInSeoul } from '@/lib/domain/dates';
import { requireSession } from '@/server/auth/session';
import { getPool } from '@/server/db/pool';
import { listReviews } from '@/server/db/reviews';
import { loadStages } from '@/server/queries';
import { Board } from './board';

export const metadata: Metadata = { title: '보드' };

export default async function BoardPage() {
  await requireSession();
  const [stages, reviews] = await Promise.all([loadStages(), listReviews(getPool(), { sort: 'priority' })]);
  return (
    <>
      <PageHeader title="보드" meta="카드를 끌어서 단계를 바꿉니다" actions={<NewReviewButton />} />
      <Board stages={stages} reviews={reviews} today={todayInSeoul()} />
    </>
  );
}
