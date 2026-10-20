'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseDateQuery } from '@/lib/domain/date-query';
import { formatDateKo, todayInSeoul } from '@/lib/domain/dates';
import { LAYOUT_LABEL, viewHref } from '@/lib/view-config';
import { searchReviewsAction } from '@/server/actions/reviews';
import type { ReviewSearchHit } from '@/server/db/reviews';
import type { SavedViewSummary } from '@/server/db/views';
import { Dot } from './badges';
import { Dialog } from './dialog';
import { IconArrowRight, IconCalendar, IconPlus, IconSearch, IconTable } from './icons';
import { NAV_ITEMS } from './nav';

interface Command {
  id: string;
  group: '리뷰' | '보기' | '만들기' | '이동';
  label: string;
  hint?: string;
  color?: string;
  icon?: 'plus' | 'calendar' | 'go' | 'view';
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onCreate,
  views,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (productName: string) => void;
  views: SavedViewSummary[];
}) {
  return (
    <Dialog open={open} onClose={onClose} label="명령 팔레트" className="mt-[12vh] mb-auto w-[min(38rem,calc(100vw-2rem))]">
      <Palette onClose={onClose} onCreate={onCreate} views={views} />
    </Dialog>
  );
}

function Palette({
  onClose,
  onCreate,
  views,
}: {
  onClose: () => void;
  onCreate: (productName: string) => void;
  views: SavedViewSummary[];
}) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ReviewSearchHit[]>([]);
  const [active, setActive] = useState(0);
  const requestId = useRef(0);

  // Debounced server search; stale responses are dropped.
  useEffect(() => {
    const q = query.trim();
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      if (!q) {
        setHits([]);
        return;
      }
      const result = await searchReviewsAction(q);
      if (id === requestId.current) setHits(result.ok ? result.data : []);
    }, 120);
    return () => clearTimeout(timer);
  }, [query]);

  const commands = useMemo<Command[]>(() => {
    const go = (href: string) => () => {
      onClose();
      router.push(href);
    };
    const q = query.trim();
    const list: Command[] = [];

    const date = q ? parseDateQuery(q, todayInSeoul()) : null;
    if (date) {
      list.push({ id: 'date', group: '이동', label: `${formatDateKo(date)}로 이동`, hint: date, icon: 'calendar', run: go(`/calendar?date=${date}`) });
    }
    for (const hit of hits) {
      list.push({
        id: `review-${hit.id}`,
        group: '리뷰',
        label: hit.productName,
        hint: [hit.brandName, hit.stageName].filter(Boolean).join(' · '),
        color: hit.stageColor,
        run: go(`/reviews/${hit.id}`),
      });
    }
    // saved views by name (all of them while the query is empty)
    const lower = q.toLowerCase();
    for (const v of views) {
      if (q && !v.name.toLowerCase().includes(lower)) continue;
      list.push({
        id: `view-${v.id}`,
        group: '보기',
        label: v.name,
        hint: `${LAYOUT_LABEL[v.layout]} 보기`,
        icon: 'view',
        run: go(viewHref(v.layout, v.id, null)),
      });
    }
    list.push({
      id: 'create',
      group: '만들기',
      label: q && !date ? `새 리뷰: ‘${q}’` : '새 리뷰 만들기',
      hint: 'C',
      icon: 'plus',
      run: () => {
        onClose();
        onCreate(date ? '' : q);
      },
    });
    if (!q || '오늘 today'.includes(lower)) {
      list.push({ id: 'today', group: '이동', label: '오늘로 이동', hint: 'T', icon: 'calendar', run: go(`/calendar?date=${todayInSeoul()}`) });
    }
    for (const item of NAV_ITEMS) {
      if (!q || item.label.includes(q) || item.keywords.some((k) => k.includes(lower))) {
        list.push({ id: `nav-${item.href}`, group: '이동', label: item.label, icon: 'go', run: go(item.href) });
      }
    }
    return list;
  }, [query, hits, views, onClose, onCreate, router]);

  const current = Math.min(active, Math.max(commands.length - 1, 0));

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((current + 1) % commands.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((current - 1 + commands.length) % commands.length);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      commands[current]?.run();
    }
  }

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4">
        <IconSearch className="size-4 text-subtle" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={commands[current] ? `${listId}-${commands[current].id}` : undefined}
          aria-label="리뷰 검색, 날짜 또는 명령"
          className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle"
          placeholder="리뷰 찾기, 날짜(예: 11/3, 내일), 명령…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="kbd">Esc</kbd>
      </div>
      <ul id={listId} role="listbox" aria-label="결과" className="overflow-y-auto p-1.5">
        {commands.map((cmd, index) => {
          const header = index === 0 || commands[index - 1]!.group !== cmd.group ? cmd.group : null;
          return (
            <li key={cmd.id} role="presentation">
              {header ? <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-subtle">{header}</div> : null}
              <div
                id={`${listId}-${cmd.id}`}
                role="option"
                aria-selected={index === current}
                className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[14px] ${
                  index === current ? 'bg-hover' : ''
                }`}
                onMouseMove={() => setActive(index)}
                onClick={() => cmd.run()}
              >
                {cmd.color ? (
                  <Dot color={cmd.color} />
                ) : cmd.icon === 'plus' ? (
                  <IconPlus className="size-3.5 text-muted" />
                ) : cmd.icon === 'calendar' ? (
                  <IconCalendar className="size-3.5 text-muted" />
                ) : cmd.icon === 'view' ? (
                  <IconTable className="size-3.5 text-muted" />
                ) : (
                  <IconArrowRight className="size-3.5 text-muted" />
                )}
                <span className="min-w-0 flex-1 truncate">{cmd.label}</span>
                {cmd.hint ? <span className="shrink-0 text-[12px] text-subtle">{cmd.hint}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
