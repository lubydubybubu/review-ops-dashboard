'use client';

import { useOptimistic, useState, useTransition } from 'react';
import { IconX } from '@/components/icons';
import { useToast } from '@/components/toast';
import {
  addChecklistItemAction,
  deleteChecklistItemAction,
  toggleChecklistItemAction,
} from '@/server/actions/reviews';
import type { ChecklistItem } from '@/server/db/checklist';

type Change = { kind: 'toggle'; id: number; doneAt: string | null } | { kind: 'delete'; id: number };

/**
 * Each change saves at once. On the detail page the server refresh brings the new items; a caller that
 * holds the items itself (the quick-edit peek) passes `onChanged` to reload them inside the same transition.
 */
export function Checklist({
  reviewId,
  items,
  readOnly,
  onChanged,
}: {
  reviewId: number;
  items: ChecklistItem[];
  readOnly: boolean;
  onChanged?: () => Promise<void>;
}) {
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [title, setTitle] = useState('');
  const [list, apply] = useOptimistic(items, (state, change: Change) =>
    change.kind === 'delete'
      ? state.filter((i) => i.id !== change.id)
      : state.map((i) => (i.id === change.id ? { ...i, doneAt: change.doneAt } : i)),
  );
  const done = list.filter((i) => i.doneAt).length;

  function run(change: Change, action: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      apply(change);
      const result = await action();
      if (!result.ok) toast(result.error ?? '저장하지 못했습니다.', { tone: 'error' });
      else await onChanged?.();
    });
  }

  function add(e: React.FormEvent) {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    setTitle('');
    startTransition(async () => {
      const result = await addChecklistItemAction({ reviewId, title: value });
      if (!result.ok) {
        setTitle(value);
        toast(result.error, { tone: 'error' });
      } else await onChanged?.();
    });
  }

  return (
    <section aria-labelledby="checklist-title">
      <h2 id="checklist-title" className="section-title">
        체크리스트
        <span className="text-[12px] font-normal text-muted tabular-nums">
          {done}/{list.length}
        </span>
      </h2>
      <ul className="mt-1">
        {list.map((item) => (
          <li key={item.id} className="group flex items-center gap-2.5 py-1.5 text-[13px]">
            <input
              type="checkbox"
              id={`check-${item.id}`}
              className="size-4 accent-[var(--accent)]"
              checked={item.doneAt !== null}
              disabled={readOnly}
              onChange={(e) =>
                run({ kind: 'toggle', id: item.id, doneAt: e.target.checked ? new Date().toISOString() : null }, () =>
                  toggleChecklistItemAction({ itemId: item.id, done: e.target.checked }),
                )
              }
            />
            <label htmlFor={`check-${item.id}`} className={`flex-1 ${item.doneAt ? 'text-subtle line-through' : ''}`}>
              {item.title}
            </label>
            {readOnly ? null : (
              <button
                type="button"
                aria-label={`${item.title} 삭제`}
                className="text-subtle opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
                onClick={() => run({ kind: 'delete', id: item.id }, () => deleteChecklistItemAction(item.id))}
              >
                <IconX className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {readOnly ? null : (
        <form onSubmit={add} className="mt-2">
          <label htmlFor="check-new" className="sr-only">
            체크리스트 항목 추가
          </label>
          <input
            id="check-new"
            className="input h-8 text-[13px]"
            placeholder="항목 추가 후 Enter"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </form>
      )}
    </section>
  );
}
