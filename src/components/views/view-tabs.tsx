'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { LAYOUT_LABEL, LAYOUTS, VIEW_NAME_MAX, viewHref, type Layout } from '@/lib/view-config';
import {
  createViewAction,
  deleteViewAction,
  duplicateViewAction,
  moveViewAction,
  renameViewAction,
} from '@/server/actions/views';
import type { SavedViewSummary } from '@/server/db/views';
import { Dialog } from '../dialog';
import { IconBoard, IconCalendar, IconPlus, IconTable } from '../icons';
import { closePopoverOf, Popover } from '../popover';
import { useToast } from '../toast';
import { useView } from './view-context';

const LAYOUT_ICON = { list: IconTable, board: IconBoard, calendar: IconCalendar } as const;

type Modal =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'rename'; view: SavedViewSummary }
  | { kind: 'delete'; view: SavedViewSummary };

/**
 * The saved views of all three layouts as one tab bar (scrolls sideways on phones). The open tab
 * carries a ⋯ menu: rename, duplicate, move left/right, delete (confirmed in an in-page dialog).
 */
export function ViewTabs() {
  const { views, view, layout } = useView();
  const router = useRouter();
  const toast = useToast();
  const [modal, setModal] = useState<Modal>({ kind: 'none' });
  const [, startTransition] = useTransition();
  const activeRef = useRef<HTMLLIElement>(null);
  const close = () => setModal({ kind: 'none' });

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [view?.id]);

  function run(task: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await task();
      if (!result.ok) toast(result.error, { tone: 'error' });
    });
  }

  const index = view ? views.findIndex((v) => v.id === view.id) : -1;
  const menuId = 'view-tab-menu';

  return (
    <nav aria-label="저장된 보기" className="mb-5 border-b border-line">
      <ul className="-mx-4 flex flex-nowrap items-end gap-0.5 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:px-0">
        {views.map((v) => {
          const Icon = LAYOUT_ICON[v.layout];
          const active = v.id === view?.id;
          return (
            <li key={v.id} ref={active ? activeRef : undefined} className="relative flex shrink-0 items-center" data-view-tab={v.id}>
              <Link
                href={viewHref(v.layout, v.id, null)}
                aria-current={active ? 'page' : undefined}
                title={`${v.name} (${LAYOUT_LABEL[v.layout]})`}
                className={`flex h-9 items-center gap-1.5 rounded-t-md px-2.5 text-[13px] whitespace-nowrap transition-colors ${
                  active ? 'font-semibold text-fg' : 'text-muted hover:bg-hover hover:text-fg'
                }`}
              >
                <Icon className={`size-3.5 ${active ? 'text-accent' : ''}`} />
                {v.name}
              </Link>
              {active ? (
                <button
                  type="button"
                  popoverTarget={menuId}
                  aria-label={`‘${v.name}’ 보기 메뉴`}
                  className="-ml-1 flex h-9 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
                >
                  <span aria-hidden className="text-[15px] leading-none">⋯</span>
                </button>
              ) : null}
              {active ? <span aria-hidden className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent" /> : null}
            </li>
          );
        })}
        <li className="shrink-0">
          <button
            type="button"
            aria-label="보기 추가"
            title="보기 추가"
            className="flex h-9 w-9 items-center justify-center rounded-t-md text-muted hover:bg-hover hover:text-fg"
            onClick={() => setModal({ kind: 'create' })}
          >
            <IconPlus className="size-3.5" />
          </button>
        </li>
      </ul>

      {view ? (
        <Popover id={menuId} label="보기 메뉴" className="w-48 p-1">
          <ul role="menu" aria-label={`‘${view.name}’ 보기`}>
            {(
              [
                ['이름 바꾸기', () => setModal({ kind: 'rename', view })],
                [
                  '복제',
                  () =>
                    startTransition(async () => {
                      const result = await duplicateViewAction({ id: view.id });
                      if (!result.ok) return toast(result.error, { tone: 'error' });
                      toast(`‘${view.name}’ 보기를 복제했습니다.`);
                      router.push(viewHref(view.layout, result.data.id, null));
                    }),
                ],
                ['← 앞으로 이동', () => run(() => moveViewAction({ id: view.id, direction: 'left' })), index <= 0],
                ['뒤로 이동 →', () => run(() => moveViewAction({ id: view.id, direction: 'right' })), index >= views.length - 1],
                ['삭제', () => setModal({ kind: 'delete', view }), false, true],
              ] as [string, () => void, boolean?, boolean?][]
            ).map(([label, act, disabled, danger]) => (
              <li key={label} role="none">
                <button
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  className={`flex w-full items-center rounded px-2.5 py-1.5 text-left hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent ${
                    danger ? 'text-danger' : ''
                  }`}
                  onClick={(e) => {
                    closePopoverOf(e.currentTarget);
                    act();
                  }}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}

      <Dialog open={modal.kind === 'create'} onClose={close} label="새 보기">
        {modal.kind === 'create' ? (
          <NameForm
            title="새 보기"
            submitLabel="만들기"
            initialName=""
            initialLayout={layout}
            onCancel={close}
            onSubmit={async (name, chosen) => {
              const result = await createViewAction({ name, layout: chosen });
              if (result.ok) {
                close();
                router.push(viewHref(chosen, result.data.id, null));
              }
              return result;
            }}
          />
        ) : null}
      </Dialog>

      <Dialog open={modal.kind === 'rename'} onClose={close} label="보기 이름 바꾸기">
        {modal.kind === 'rename' ? (
          <NameForm
            title="보기 이름 바꾸기"
            submitLabel="저장"
            initialName={modal.view.name}
            onCancel={close}
            onSubmit={async (name) => {
              const result = await renameViewAction({ id: modal.view.id, name });
              if (result.ok) close();
              return result;
            }}
          />
        ) : null}
      </Dialog>

      <Dialog open={modal.kind === 'delete'} onClose={close} label="보기 삭제">
        {modal.kind === 'delete' ? (
          <DeleteConfirm
            view={modal.view}
            onCancel={close}
            onConfirm={async () => {
              const result = await deleteViewAction({ id: modal.view.id });
              if (result.ok) {
                close();
                toast(`‘${modal.view.name}’ 보기를 삭제했습니다.`);
                if (modal.view.id === view?.id) router.replace(viewHref(modal.view.layout, null, null));
              }
              return result;
            }}
          />
        ) : null}
      </Dialog>
    </nav>
  );
}

/** A view name (and, for a new view, its layout); also used by the toolbar's "새 보기로 저장". */
export function NameForm({
  title,
  submitLabel,
  initialName,
  initialLayout,
  onCancel,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initialName: string;
  /** set → the form also asks for the layout (new view) */
  initialLayout?: Layout;
  onCancel: () => void;
  onSubmit: (name: string, layout: Layout) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [name, setName] = useState(initialName);
  const [layout, setLayout] = useState<Layout>(initialLayout ?? 'list');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await onSubmit(name, layout);
          setError(result.ok ? null : result.error);
        });
      }}
    >
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <div>
        <label htmlFor="view-name" className="label">
          보기 이름
        </label>
        <input
          id="view-name"
          className="input"
          autoFocus
          maxLength={VIEW_NAME_MAX}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'view-name-error' : undefined}
        />
        {error ? (
          <p id="view-name-error" role="alert" className="mt-1 text-[12px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
      {initialLayout ? (
        <fieldset>
          <legend className="label">레이아웃</legend>
          <div className="flex gap-1.5">
            {LAYOUTS.map((l) => {
              const Icon = LAYOUT_ICON[l];
              return (
                <label
                  key={l}
                  className={`flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border text-[13px] ${
                    layout === l ? 'border-line-strong bg-hover font-semibold' : 'border-line text-muted'
                  }`}
                >
                  <input type="radio" name="view-layout" value={l} checked={layout === l} onChange={() => setLayout(l)} className="sr-only" />
                  <Icon className="size-3.5" />
                  {LAYOUT_LABEL[l]}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          취소
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function DeleteConfirm({
  view,
  onCancel,
  onConfirm,
}: {
  view: SavedViewSummary;
  onCancel: () => void;
  onConfirm: () => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-4 p-5">
      <h2 className="text-[15px] font-semibold">‘{view.name}’ 보기를 삭제할까요?</h2>
      <p className="text-[13px] text-muted">보기 설정만 지워집니다. 리뷰는 그대로 남습니다.</p>
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel} autoFocus>
          취소
        </button>
        <button
          type="button"
          className="btn border-danger bg-danger text-accent-fg hover:bg-danger hover:brightness-95"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await onConfirm();
              setError(result.ok ? null : result.error);
            })
          }
        >
          삭제
        </button>
      </div>
    </div>
  );
}
