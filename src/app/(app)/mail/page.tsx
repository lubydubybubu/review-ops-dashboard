import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { todayInSeoul } from '@/lib/domain/dates';
import { requireSession } from '@/server/auth/session';
import { listMailInbox } from '@/server/db/mail';
import { getPool } from '@/server/db/pool';
import { loadMailPending } from '@/server/queries';
import { MailInbox } from './mail-inbox';

export const metadata: Metadata = { title: '메일 의뢰' };

/** `?before=<candidate id>`: the older page after that candidate. Anything else is the first page. */
function cursor(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,14}$/.test(value)) return null;
  return Number(value);
}

export default async function MailPage({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  await requireSession();
  const beforeId = cursor((await searchParams).before);
  // the pending total comes from the layout's request-cached count, so it stays right past one page
  const [inbox, pending] = await Promise.all([listMailInbox(getPool(), { beforeId }), loadMailPending()]);
  return (
    <div className="max-w-4xl">
      <PageHeader
        title="메일 의뢰"
        meta={`메일에서 찾은 리뷰 의뢰 · 대기 ${pending}건 — 확인한 것만 리뷰가 됩니다`}
      />
      <MailInbox
        open={inbox.open}
        dismissed={inbox.dismissed}
        olderPage={beforeId !== null}
        hasMore={inbox.hasMore}
        today={todayInSeoul()}
      />
    </div>
  );
}
