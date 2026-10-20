'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { todayInSeoul } from '@/lib/domain/dates';
import type { Stage } from '@/lib/domain/review';
import { logout } from '@/server/actions/auth';
import type { UserSettings } from '@/server/db/settings';
import { CommandPalette } from './command-palette';
import { Dialog } from './dialog';
import {
  IconBoard,
  IconCalendar,
  IconHome,
  IconLogout,
  IconMenu,
  IconPlus,
  IconSearch,
  IconSliders,
  IconTable,
  IconTag,
  IconX,
} from './icons';
import { NAV_ITEMS } from './nav';
import { QuickCreateDialog } from './quick-create';
import { ReviewPeek, type PeekHandle } from './review-peek';
import { OPS_EVENTS, ShellContext, type QuickCreatePrefill, type ShellApi, type TemplateOption } from './shell-context';
import { ToastProvider } from './toast';

const ICONS = {
  home: IconHome,
  table: IconTable,
  board: IconBoard,
  calendar: IconCalendar,
  tag: IconTag,
  settings: IconSliders,
} as const;

type Overlay = { kind: 'none' } | { kind: 'palette' } | { kind: 'shortcuts' } | { kind: 'create'; prefill: QuickCreatePrefill };

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function AppShell({
  stages,
  templates,
  brands,
  settings,
  children,
}: {
  stages: Stage[];
  templates: TemplateOption[];
  brands: { id: number; name: string }[];
  settings: UserSettings;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [overlay, setOverlay] = useState<Overlay>({ kind: 'none' });
  const [menuOpen, setMenuOpen] = useState(false);
  const close = useCallback(() => setOverlay({ kind: 'none' }), []);
  const openQuickCreate = useCallback((prefill: QuickCreatePrefill = {}) => setOverlay({ kind: 'create', prefill }), []);
  const openPalette = useCallback(() => setOverlay({ kind: 'palette' }), []);
  const createFromPalette = useCallback((productName: string) => openQuickCreate({ productName }), [openQuickCreate]);
  const peekRef = useRef<PeekHandle>(null);
  const openPeek = useCallback<ShellApi['openPeek']>((id, returnFocus) => peekRef.current?.open(id, returnFocus), []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOverlay((o) => (o.kind === 'palette' ? { kind: 'none' } : { kind: 'palette' }));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || isTyping(e.target)) return;
      if (document.querySelector('dialog[open]')) return;

      if (e.key === 'c' || e.key === 'C' || e.key === 'ㅊ') {
        e.preventDefault();
        setOverlay({ kind: 'create', prefill: {} });
      } else if (e.key === 't' || e.key === 'T' || e.key === 'ㅅ') {
        e.preventDefault();
        if (window.location.pathname === '/calendar') window.dispatchEvent(new Event(OPS_EVENTS.calendarToday));
        else router.push(`/calendar?date=${todayInSeoul()}`);
      } else if (e.key === '?') {
        e.preventDefault();
        setOverlay({ kind: 'shortcuts' });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router]);

  const api = useMemo<ShellApi>(
    () => ({ stages, templates, brands, settings, openQuickCreate, openPalette, openPeek }),
    [stages, templates, brands, settings, openQuickCreate, openPalette, openPeek],
  );

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  const navLinks = (
    <ul className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const Icon = ICONS[item.icon];
        const active = isActive(item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
              className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[14px] transition-colors ${
                active ? 'bg-hover font-semibold text-fg' : 'text-muted hover:bg-hover hover:text-fg'
              }`}
            >
              <Icon className={`size-4 ${active ? 'text-accent' : ''}`} />
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  const logoutButton = (
    <form action={logout}>
      <button
        type="submit"
        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[14px] text-muted hover:bg-hover hover:text-fg"
      >
        <IconLogout className="size-4" />
        로그아웃
      </button>
    </form>
  );

  return (
    <ShellContext.Provider value={api}>
      <ToastProvider>
        <div className="min-h-dvh md:grid md:grid-cols-[13.5rem_minmax(0,1fr)]">
          {/* desktop sidebar */}
          <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-line px-3 py-5 md:flex">
            <Link href="/" className="flex items-center gap-2 px-2.5 text-[15px] font-bold tracking-tight">
              <span aria-hidden className="inline-block size-2 rounded-full bg-accent" />
              Review Ops
            </Link>
            <div className="flex flex-col gap-1.5 px-0.5">
              <button type="button" className="btn btn-primary w-full justify-between" onClick={() => openQuickCreate()}>
                <span className="inline-flex items-center gap-1.5">
                  <IconPlus className="size-3.5" />새 리뷰
                </span>
                <kbd className="text-[11px] opacity-80">C</kbd>
              </button>
              <button type="button" className="btn w-full justify-between text-muted" onClick={openPalette}>
                <span className="inline-flex items-center gap-1.5">
                  <IconSearch className="size-3.5" />
                  검색
                </span>
                <kbd className="text-[11px]">Ctrl K</kbd>
              </button>
            </div>
            <nav aria-label="주 메뉴">{navLinks}</nav>
            <div className="mt-auto flex flex-col gap-0.5">
              <button
                type="button"
                className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-subtle hover:bg-hover"
                onClick={() => setOverlay({ kind: 'shortcuts' })}
              >
                <kbd className="kbd">?</kbd> 단축키
              </button>
              {logoutButton}
            </div>
          </aside>

          {/* mobile top bar */}
          <header className="sticky top-0 z-30 flex h-12 items-center gap-1 border-b border-line bg-bg/95 px-2 backdrop-blur md:hidden">
            <button
              type="button"
              className="btn btn-ghost px-2"
              aria-label={menuOpen ? '메뉴 닫기' : '메뉴 열기'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {menuOpen ? <IconX /> : <IconMenu />}
            </button>
            <Link href="/" className="flex items-center gap-1.5 text-[15px] font-bold tracking-tight">
              <span aria-hidden className="inline-block size-2 rounded-full bg-accent" />
              Review Ops
            </Link>
            <div className="ml-auto flex items-center">
              <button type="button" className="btn btn-ghost px-2" aria-label="검색" onClick={openPalette}>
                <IconSearch />
              </button>
              <button type="button" className="btn btn-ghost px-2 text-accent" aria-label="새 리뷰" onClick={() => openQuickCreate()}>
                <IconPlus />
              </button>
            </div>
          </header>
          {menuOpen ? (
            <nav aria-label="주 메뉴" className="sticky top-12 z-20 border-b border-line bg-bg px-3 py-3 md:hidden">
              {navLinks}
              <div className="mt-2 border-t border-line pt-2">{logoutButton}</div>
            </nav>
          ) : null}

          <main className="min-w-0 px-4 pt-5 pb-16 md:px-10 md:pt-8">{children}</main>
        </div>

        <ReviewPeek ref={peekRef} />
        {overlay.kind === 'create' ? <QuickCreateDialog open prefill={overlay.prefill} onClose={close} /> : null}
        {overlay.kind === 'palette' ? <CommandPalette open onClose={close} onCreate={createFromPalette} /> : null}
        <Dialog open={overlay.kind === 'shortcuts'} onClose={close} label="단축키">
          <ShortcutSheet />
        </Dialog>
      </ToastProvider>
    </ShellContext.Provider>
  );
}

const SHORTCUTS: [string[], string][] = [
  [['Ctrl/⌘', 'K'], '명령 팔레트 (리뷰 찾기 · 날짜 이동 · 만들기)'],
  [['C'], '새 리뷰'],
  [['T'], '오늘 (캘린더)'],
  [['?'], '단축키 보기'],
  [['Esc'], '창 닫기'],
  [['←', '→'], '캘린더 이전 / 다음'],
  [['M', 'W'], '캘린더 월 / 주 보기'],
  [['+', '−'], '주 보기 시간 확대 / 축소'],
  [['Ctrl/⌘', 'S'], '리뷰 저장 (상세 · 빠른 편집)'],
  [['Ctrl/⌘', 'Enter'], '빠른 편집 → 전체 페이지로 열기'],
];

function ShortcutSheet() {
  return (
    <div className="p-5">
      <h2 className="mb-3 text-[15px] font-semibold">단축키</h2>
      <dl className="divide-y divide-line">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={label} className="flex items-center justify-between gap-4 py-2 text-[13px]">
            <dt className="text-muted">{label}</dt>
            <dd className="flex shrink-0 gap-1">
              {keys.map((k) => (
                <kbd key={k} className="kbd">
                  {k}
                </kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
