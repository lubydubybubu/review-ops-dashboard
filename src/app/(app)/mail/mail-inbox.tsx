'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { Dialog } from '@/components/dialog';
import { IconArrowRight } from '@/components/icons';
import { useShell } from '@/components/shell-context';
import { useToast } from '@/components/toast';
import { formatDateShort, kstDateOf, kstTimeOf, type IsoDate } from '@/lib/domain/dates';
import {
  brandMatcher,
  gmailMessageUrl,
  MAIL_DEADLINE_LABEL,
  MAIL_DEADLINES,
  MAIL_INBOX_PAGE,
  MAIL_SOURCE_TYPE_LABEL,
  MAIL_UNDO_DAYS,
  type MailCandidate,
} from '@/lib/mail';
import {
  dismissMailCandidateAction,
  linkMailCandidateAction,
  undoDismissMailCandidateAction,
} from '@/server/actions/mail';
import { searchReviewsAction } from '@/server/actions/reviews';
import type { ReviewSearchHit } from '@/server/db/reviews';

/**
 * The mail inbox. Every string from a mail is rendered as a React text node (escaped plain text):
 * never dangerouslySetInnerHTML, never markdown. The only link built from mail data is the Gmail one,
 * from the hex-checked message id.
 */
export function MailInbox({
  open,
  dismissed,
  olderPage,
  hasMore,
  today,
}: {
  open: MailCandidate[];
  dismissed: MailCandidate[];
  /** this is a 더 보기 page (not the newest one) */
  olderPage: boolean;
  /** older open candidates exist beyond this page */
  hasMore: boolean;
  today: IsoDate;
}) {
  const [linking, setLinking] = useState<MailCandidate | null>(null);
  const { brands } = useShell();
  // one normalized index per render instead of a scan of every brand for every card
  const findBrand = useMemo(() => brandMatcher(brands), [brands]);
  const moreHref = hasMore && open.length > 0 ? `/mail?before=${open[open.length - 1]!.id}` : null;

  return (
    <>
      {olderPage || moreHref ? (
        <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted" data-testid={moreHref ? 'mail-truncated' : undefined}>
          <span>{olderPage ? '더 오래된 메일 의뢰' : `최근 ${MAIL_INBOX_PAGE}건만 표시 중`}</span>
          {olderPage ? (
            <Link href="/mail" className="underline-offset-2 hover:text-fg hover:underline">
              최신으로
            </Link>
          ) : null}
          {moreHref ? (
            <Link href={moreHref} className="underline-offset-2 hover:text-fg hover:underline">
              더 보기
            </Link>
          ) : null}
        </p>
      ) : null}

      {open.length === 0 ? (
        <p className="border-y border-line py-10 text-center text-[13px] text-muted">
          {olderPage ? '더 오래된 메일 의뢰가 없습니다.' : '새 메일 의뢰가 없습니다.'}
        </p>
      ) : (
        <ul className="divide-y divide-line border-y border-line" aria-label="메일 의뢰 목록">
          {open.map((c) => (
            <li key={c.id}>
              <CandidateCard candidate={c} today={today} knownBrand={findBrand(c.extracted.brand_name) !== undefined} onLink={() => setLinking(c)} />
            </li>
          ))}
        </ul>
      )}

      {moreHref ? (
        <div className="mt-3 flex justify-center">
          <Link href={moreHref} className="btn">
            더 보기
          </Link>
        </div>
      ) : null}

      {dismissed.length > 0 ? (
        <section aria-labelledby="mail-dismissed" className="mt-10">
          <h2 id="mail-dismissed" className="section-title">
            최근 무시함
            <span className="text-[12px] font-normal text-muted">{MAIL_UNDO_DAYS}일 안에 되돌릴 수 있습니다</span>
          </h2>
          <ul className="divide-y divide-line">
            {dismissed.map((c) => (
              <li key={c.id}>
                <DismissedRow candidate={c} today={today} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Dialog open={linking !== null} onClose={() => setLinking(null)} label="기존 리뷰에 연결">
        {linking ? <LinkReviewForm candidate={linking} onClose={() => setLinking(null)} /> : null}
      </Dialog>
    </>
  );
}

function sender(c: MailCandidate): string {
  return c.fromName ? `${c.fromName} <${c.fromAddress}>` : c.fromAddress;
}

function receivedLabel(c: MailCandidate, today: IsoDate): string {
  return `${formatDateShort(kstDateOf(c.receivedAt), today)} ${kstTimeOf(c.receivedAt)}`;
}

function CandidateCard({
  candidate: c,
  today,
  knownBrand,
  onLink,
}: {
  candidate: MailCandidate;
  today: IsoDate;
  /** the extracted brand matches an existing one (brandMatcher, built once per inbox render) */
  knownBrand: boolean;
  onLink: () => void;
}) {
  const { openQuickCreate } = useShell();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const x = c.extracted;
  const gmail = gmailMessageUrl(c.messageId);
  const deadlines = MAIL_DEADLINES.filter((k) => x.deadlines[k]);
  const confidence = Math.round(c.confidence * 100);

  function register() {
    const memo = [x.notes, x.deadlines.return_by ? `반납 기한: ${x.deadlines.return_by}` : null].filter(Boolean).join('\n');
    openQuickCreate({
      mail: {
        candidateId: c.id,
        version: c.version,
        subject: c.subject,
        sender: c.fromName ?? c.fromAddress,
        productName: x.product_name ?? '',
        brandName: x.brand_name,
        sourceType: x.source_type === 'unknown' ? null : x.source_type,
        writeDueOn: x.deadlines.write_by,
        publishPlannedOn: x.deadlines.publish,
        embargoUntil: x.deadlines.embargo,
        memo,
      },
    });
  }

  function dismiss() {
    startTransition(async () => {
      const result = await dismissMailCandidateAction(c.id, c.version);
      if (!result.ok) return toast(result.error, { tone: 'error' });
      const version = result.data.version;
      toast('메일 의뢰를 무시했습니다.', {
        action: {
          label: '되돌리기',
          onClick: () => {
            void undoDismissMailCandidateAction(c.id, version).then((r) =>
              r.ok ? toast('되돌렸습니다.') : toast(r.error, { tone: 'error' }),
            );
          },
        },
      });
    });
  }

  return (
    <article className="flex flex-col gap-2 py-4" data-mail-id={c.id} data-mail-status={c.status} aria-label={c.subject || '(제목 없음)'}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] text-muted">
        <span className="min-w-0 max-w-full truncate" data-testid="mail-sender">
          {sender(c)}
        </span>
        <span className="whitespace-nowrap tabular-nums">{receivedLabel(c, today)}</span>
        <span className={`whitespace-nowrap tabular-nums ${confidence < 50 ? 'text-warn' : ''}`} title="의뢰일 가능성 (자동 판단)">
          신뢰도 {confidence}%
        </span>
        {gmail ? (
          <a href={gmail} target="_blank" rel="noopener noreferrer" className="ml-auto whitespace-nowrap hover:text-fg" data-testid="mail-gmail">
            Gmail에서 열기 ↗
          </a>
        ) : null}
      </div>

      <h3 className="text-[15px] font-semibold break-words" data-testid="mail-subject">
        {c.subject || '(제목 없음)'}
      </h3>

      {c.status === 'duplicate' && c.reviewId ? (
        <p className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <span className="rounded-sm bg-accent-soft px-1.5 font-semibold text-accent">같은 스레드 새 메일</span>
          <Link href={`/reviews/${c.reviewId}`} className="text-muted underline-offset-2 hover:text-fg hover:underline">
            이미 등록된 리뷰: ‘{c.reviewName ?? `#${c.reviewId}`}’
          </Link>
        </p>
      ) : null}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[13px] sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <dt className="text-muted">브랜드</dt>
        <dd className="min-w-0 break-words" data-testid="mail-brand">
          {x.brand_name ?? <span className="text-subtle">없음</span>}
          {x.brand_name ? (
            <span className="ml-1.5 text-[11px] text-subtle">{knownBrand ? '기존 브랜드' : '새 브랜드'}</span>
          ) : null}
        </dd>
        <dt className="text-muted">제품</dt>
        <dd className="min-w-0 break-words" data-testid="mail-product">
          {x.product_name ?? <span className="text-subtle">못 찾음</span>}
        </dd>
        <dt className="text-muted">형태</dt>
        <dd>{MAIL_SOURCE_TYPE_LABEL[x.source_type]}</dd>
        <dt className="text-muted">일정</dt>
        <dd className="flex flex-wrap gap-x-2" data-testid="mail-deadlines">
          {deadlines.length === 0 ? (
            <span className="text-subtle">없음</span>
          ) : (
            deadlines.map((k) => (
              <span key={k} className="whitespace-nowrap">
                {MAIL_DEADLINE_LABEL[k]} {formatDateShort(x.deadlines[k]!, today)}
              </span>
            ))
          )}
        </dd>
      </dl>

      {x.notes ? <p className="text-[13px] whitespace-pre-wrap text-muted break-words">{x.notes}</p> : null}

      {c.evidence.length > 0 ? (
        <ul className="flex flex-col gap-0.5" aria-label="근거 문장">
          {c.evidence.map((line, i) => (
            <li key={i} className="border-l-2 border-line-strong pl-2 text-[12px] text-muted break-words" data-testid="mail-evidence">
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      {c.snippet ? (
        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer select-none hover:text-fg">메일 미리보기</summary>
          <p className="mt-1 whitespace-pre-wrap break-words" data-testid="mail-snippet">
            {c.snippet}
          </p>
        </details>
      ) : null}

      <div className="mt-1 flex flex-wrap gap-2">
        {c.status === 'duplicate' && c.reviewId ? (
          // usually a follow-up of the review it is linked to; a new review stays possible
          <>
            <Link href={`/reviews/${c.reviewId}`} className="btn btn-primary">
              리뷰 열기
            </Link>
            <button type="button" className="btn" onClick={register} disabled={pending}>
              새 리뷰로 등록
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={register} disabled={pending}>
              리뷰로 등록
            </button>
            <button type="button" className="btn" onClick={onLink} disabled={pending}>
              기존 리뷰에 연결
            </button>
          </>
        )}
        <button type="button" className="btn btn-ghost text-muted" onClick={dismiss} disabled={pending}>
          무시
        </button>
      </div>
    </article>
  );
}

function DismissedRow({ candidate: c, today }: { candidate: MailCandidate; today: IsoDate }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  function undo() {
    startTransition(async () => {
      const result = await undoDismissMailCandidateAction(c.id, c.version);
      if (!result.ok) return toast(result.error, { tone: 'error' });
      toast('되돌렸습니다.');
    });
  }

  return (
    <div className="flex items-center gap-3 py-2.5" data-mail-id={c.id} data-mail-status="dismissed">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]">{c.subject || '(제목 없음)'}</p>
        <p className="truncate text-[12px] text-muted">
          {sender(c)} · {receivedLabel(c, today)}
        </p>
      </div>
      <button type="button" className="btn h-8" onClick={undo} disabled={pending}>
        되돌리기
      </button>
    </div>
  );
}

function LinkReviewForm({ candidate, onClose }: { candidate: MailCandidate; onClose: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState(candidate.extracted.product_name ?? candidate.extracted.brand_name ?? '');
  const [hits, setHits] = useState<ReviewSearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const term = q.trim();
    let live = true;
    const timer = setTimeout(() => {
      if (!term) return setHits([]);
      void searchReviewsAction(term).then((r) => {
        if (live) setHits(r.ok ? r.data : []);
      });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  function link(hit: ReviewSearchHit) {
    setError(null);
    startTransition(async () => {
      const result = await linkMailCandidateAction(candidate.id, candidate.version, hit.id);
      if (!result.ok) return setError(result.error);
      onClose();
      toast(`‘${hit.productName}’ 리뷰에 연결했습니다.`, { action: { label: '열기', href: `/reviews/${hit.id}` } });
    });
  }

  return (
    <div className="flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-[15px] font-semibold">기존 리뷰에 연결</h2>
        <p className="mt-0.5 truncate text-[12px] text-muted">{candidate.subject || '(제목 없음)'}</p>
      </div>
      <label htmlFor="mail-link-q" className="sr-only">
        리뷰 검색
      </label>
      <input
        id="mail-link-q"
        className="input"
        autoFocus
        autoComplete="off"
        maxLength={100}
        placeholder="제품명·작업 제목·브랜드로 찾기"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="flex max-h-72 flex-col overflow-y-auto" aria-label="검색 결과">
        {hits.length === 0 ? (
          <li className="py-4 text-center text-[13px] text-muted">{q.trim() ? '찾는 리뷰가 없습니다.' : '검색어를 입력하세요.'}</li>
        ) : (
          hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] hover:bg-hover disabled:opacity-50"
                onClick={() => link(hit)}
                disabled={pending}
              >
                <span className="min-w-0 flex-1 truncate font-medium">{hit.productName}</span>
                <span className="shrink-0 text-[12px] text-muted">{[hit.brandName, hit.stageName].filter(Boolean).join(' · ')}</span>
                <IconArrowRight className="size-3.5 shrink-0 text-subtle" />
              </button>
            </li>
          ))
        )}
      </ul>
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end border-t border-line pt-3">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          취소
        </button>
      </div>
    </div>
  );
}
