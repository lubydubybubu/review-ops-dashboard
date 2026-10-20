'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CATEGORY_KEYS, CATEGORY_LABEL, type Stage } from '@/lib/domain/review';
import { filterHref, FILTER_FIELDS, type ReviewFilterParams } from '@/lib/review-filter';

const FIELD_LABEL: Record<(typeof FILTER_FIELDS)[number], string> = {
  received: '입고일',
  shoot: '촬영일',
  write_due: '작성 마감',
  publish_planned: '발행 예정',
  embargo: '엠바고',
};

export function ReviewFilters({
  params,
  stages,
  brands,
}: {
  params: ReviewFilterParams;
  stages: Stage[];
  brands: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [q, setQ] = useState(params.q ?? '');
  const go = (patch: Parameters<typeof filterHref>[1]) => router.replace(filterHref(params, patch), { scroll: false });

  // Debounce the text search into the URL.
  useEffect(() => {
    if ((params.q ?? '') === q.trim()) return;
    const timer = setTimeout(() => router.replace(filterHref(params, { q: q.trim() }), { scroll: false }), 250);
    return () => clearTimeout(timer);
  }, [q, params, router]);

  const stageValue = params.stage ? String(params.stage) : params.category ? `cat:${params.category}` : '';
  const hasFilters = Boolean(params.q || params.stage || params.category || params.brand || params.from || params.to);

  return (
    <div className="mb-4 flex flex-wrap items-end gap-2" role="search" aria-label="리뷰 필터">
      <div className="w-full sm:w-56">
        <label htmlFor="f-q" className="sr-only">
          검색
        </label>
        <input
          id="f-q"
          className="input"
          placeholder="제품·브랜드 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="f-stage" className="sr-only">
          단계
        </label>
        <select
          id="f-stage"
          className="input w-auto"
          value={stageValue}
          onChange={(e) => {
            const v = e.target.value;
            go(v.startsWith('cat:') ? { category: v.slice(4), stage: undefined } : { stage: v || undefined, category: undefined });
          }}
        >
          <option value="">모든 단계</option>
          {CATEGORY_KEYS.map((c) => (
            <optgroup key={c} label={CATEGORY_LABEL[c]}>
              <option value={`cat:${c}`}>{CATEGORY_LABEL[c]} 전체</option>
              {stages
                .filter((s) => s.categoryKey === c)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="f-brand" className="sr-only">
          브랜드
        </label>
        <select
          id="f-brand"
          className="input w-auto"
          value={params.brand ?? ''}
          onChange={(e) => go({ brand: e.target.value || undefined })}
        >
          <option value="">모든 브랜드</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-1.5">
        <label htmlFor="f-field" className="sr-only">
          날짜 기준
        </label>
        <select
          id="f-field"
          className="input w-auto"
          value={params.field ?? 'publish_planned'}
          onChange={(e) => go({ field: e.target.value })}
        >
          {FILTER_FIELDS.map((f) => (
            <option key={f} value={f}>
              {FIELD_LABEL[f]}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label="시작일"
          className="input w-[9.5rem]"
          value={params.from ?? ''}
          onChange={(e) => go({ from: e.target.value || undefined, field: params.field ?? 'publish_planned' })}
        />
        <span className="text-subtle">–</span>
        <input
          type="date"
          aria-label="종료일"
          className="input w-[9.5rem]"
          value={params.to ?? ''}
          onChange={(e) => go({ to: e.target.value || undefined, field: params.field ?? 'publish_planned' })}
        />
      </div>
      <div className="ml-auto flex items-center gap-3 text-[13px]">
        {hasFilters ? (
          <Link href={params.archived ? '/reviews?archived=1' : '/reviews'} className="text-muted hover:text-fg" onClick={() => setQ('')}>
            필터 지우기
          </Link>
        ) : null}
        <Link href={params.archived ? '/reviews' : '/reviews?archived=1'} className="text-muted hover:text-fg">
          {params.archived ? '진행 목록 보기' : '보관함'}
        </Link>
      </div>
    </div>
  );
}
