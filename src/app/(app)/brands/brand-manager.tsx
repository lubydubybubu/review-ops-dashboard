'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useToast } from '@/components/toast';
import { createBrandAction, setBrandArchivedAction, updateBrandAction } from '@/server/actions/brands';
import type { Brand, BrandStatus } from '@/server/db/brands';

const STATUS_LABEL: Record<BrandStatus, string> = { active: '진행 중', prospect: '검토', paused: '쉬는 중' };
const STATUSES = Object.keys(STATUS_LABEL) as BrandStatus[];

interface Draft {
  name: string;
  status: BrandStatus;
  category: string;
  website: string;
}

const emptyDraft: Draft = { name: '', status: 'active', category: '', website: '' };

export function BrandManager({ brands }: { brands: Brand[] }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<{ id: number; draft: Draft } | null>(null);

  function create(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await createBrandAction(draft);
      if (!result.ok) return toast(result.error, { tone: 'error' });
      toast(`‘${draft.name.trim()}’을(를) 추가했습니다.`);
      setDraft(emptyDraft);
    });
  }

  function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    startTransition(async () => {
      const result = await updateBrandAction({ id: editing.id, ...editing.draft });
      if (!result.ok) return toast(result.error, { tone: 'error' });
      setEditing(null);
    });
  }

  function setStatus(brand: Brand, status: BrandStatus) {
    startTransition(async () => {
      const result = await updateBrandAction({ ...brand, status, category: brand.category ?? '', website: brand.website ?? '' });
      if (!result.ok) toast(result.error, { tone: 'error' });
    });
  }

  function archive(brand: Brand, archived: boolean) {
    startTransition(async () => {
      const result = await setBrandArchivedAction(brand.id, archived);
      if (!result.ok) return toast(result.error, { tone: 'error' });
      toast(archived ? `‘${brand.name}’을(를) 보관했습니다. 연결된 리뷰는 그대로 남습니다.` : `‘${brand.name}’을(를) 되살렸습니다.`);
    });
  }

  return (
    <>
      <form onSubmit={create} aria-label="브랜드 추가" className="mb-8 grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_8rem_minmax(0,1fr)_auto]">
        <label htmlFor="brand-name" className="sr-only">
          브랜드 이름
        </label>
        <input
          id="brand-name"
          className="input"
          placeholder="새 브랜드 이름"
          required
          maxLength={120}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <label htmlFor="brand-status" className="sr-only">
          상태
        </label>
        <select
          id="brand-status"
          className="input"
          value={draft.status}
          onChange={(e) => setDraft({ ...draft, status: e.target.value as BrandStatus })}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <label htmlFor="brand-category" className="sr-only">
          분류
        </label>
        <input
          id="brand-category"
          className="input"
          placeholder="분류 (선택)"
          maxLength={60}
          value={draft.category}
          onChange={(e) => setDraft({ ...draft, category: e.target.value })}
        />
        <button type="submit" className="btn btn-primary" disabled={pending}>
          추가
        </button>
      </form>

      {brands.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-muted">브랜드가 없습니다. 위에서 추가하세요.</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {brands.map((brand) =>
            editing?.id === brand.id ? (
              <li key={brand.id} className="py-3">
                <form onSubmit={saveEdit} className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto_auto]">
                  <input
                    aria-label="이름"
                    className="input"
                    required
                    autoFocus
                    value={editing.draft.name}
                    onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })}
                  />
                  <input
                    aria-label="분류"
                    className="input"
                    placeholder="분류"
                    value={editing.draft.category}
                    onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, category: e.target.value } })}
                  />
                  <input
                    aria-label="웹사이트"
                    className="input"
                    placeholder="https://"
                    value={editing.draft.website}
                    onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, website: e.target.value } })}
                  />
                  <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
                    취소
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={pending}>
                    저장
                  </button>
                </form>
              </li>
            ) : (
              <li key={brand.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 py-3 ${brand.archivedAt ? 'opacity-55' : ''}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {brand.name}
                    {brand.archivedAt ? <span className="ml-2 text-[12px] font-normal text-muted">보관됨</span> : null}
                  </p>
                  <p className="text-[12px] text-muted">
                    {[brand.category, brand.website].filter(Boolean).join(' · ') || ' '}
                  </p>
                </div>
                <Link href={`/reviews?brand=${brand.id}`} className="text-[13px] text-muted tabular-nums hover:text-fg">
                  리뷰 {brand.reviewCount}
                </Link>
                <label className="sr-only" htmlFor={`status-${brand.id}`}>
                  {brand.name} 상태
                </label>
                <select
                  id={`status-${brand.id}`}
                  className="input h-8 w-auto text-[13px]"
                  value={brand.status}
                  disabled={pending || brand.archivedAt !== null}
                  onChange={(e) => setStatus(brand, e.target.value as BrandStatus)}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
                <div className="flex gap-1">
                  {brand.archivedAt ? null : (
                    <button
                      type="button"
                      className="btn btn-ghost h-8 text-muted"
                      onClick={() =>
                        setEditing({
                          id: brand.id,
                          draft: { name: brand.name, status: brand.status, category: brand.category ?? '', website: brand.website ?? '' },
                        })
                      }
                    >
                      편집
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost h-8 text-muted" disabled={pending} onClick={() => archive(brand, !brand.archivedAt)}>
                    {brand.archivedAt ? '되살리기' : '보관'}
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
    </>
  );
}
