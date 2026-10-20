'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, useTransition } from 'react';
import { Checklist } from '@/app/(app)/reviews/[id]/checklist';
import { diffDays, formatDateShort, todayInSeoul } from '@/lib/domain/dates';
import { overdueFields } from '@/lib/domain/overdue';
import {
  CALENDAR_FIELD_META,
  CATEGORY_KEYS,
  CATEGORY_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  SOURCE_TYPE_LABEL,
  SOURCE_TYPES,
  type CalendarField,
} from '@/lib/domain/review';
import { REVIEW_STALE_MESSAGE, toReviewForm, type ReviewFormState } from '@/lib/review-form';
import { reviewPeekAction, updateReviewAction } from '@/server/actions/reviews';
import type { ChecklistItem } from '@/server/db/checklist';
import type { ReviewDetail } from '@/server/db/reviews';
import { Dot, OverdueTag } from './badges';
import { IconArrowRight, IconX } from './icons';
import { OPS_EVENTS, useShell } from './shell-context';
import { useToast } from './toast';

export interface PeekHandle {
  open: (reviewId: number, returnFocus?: () => HTMLElement | null) => void;
}

interface Target {
  id: number;
  returnFocus: () => HTMLElement | null;
  /** path the peek was opened on; navigating elsewhere closes it */
  pathname: string;
}

type Loaded = { review: ReviewDetail; checklist: ChecklistItem[] };

/** Phones get a bottom sheet (modal); wider screens a side panel next to the content (non-modal). */
const SHEET_QUERY = '(max-width: 640px)';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function setPeekParam(id: number | null) {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete('peek');
  else url.searchParams.set('peek', String(id));
  // App Router syncs with history.replaceState (no server round trip, no remount).
  if (url.href !== window.location.href) window.history.replaceState(null, '', url);
}

/**
 * Quick edit for one review ("side peek"): the most-used fields, saved through the same action,
 * schema and DB rules as the full page (`updateReviewAction` with the whole form), refused if the
 * review changed elsewhere since it loaded. A native <dialog>: shown non-modally on desktop so the
 * page behind stays usable (Tab is kept inside by hand), modally as a bottom sheet on phones.
 * Esc / ✕ close (with an unsaved-changes guard), Ctrl/⌘+S saves, Ctrl/⌘+Enter opens the full page.
 */
export function ReviewPeek({ ref }: { ref: React.Ref<PeekHandle> }) {
  const { stages, brands } = useShell();
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const uid = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [sheet, setSheet] = useState(false);
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initial, setInitial] = useState<ReviewFormState | null>(null);
  const [form, setForm] = useState<ReviewFormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  /** set while the unsaved-changes question is showing: what to do after "버리고 닫기" */
  const [guard, setGuard] = useState<{ then: () => void } | null>(null);
  const [pending, startTransition] = useTransition();
  const latest = useRef<number | null>(null);

  const dirty = form !== null && initial !== null && JSON.stringify(form) !== JSON.stringify(initial);
  const review = data?.review;
  const archived = review?.archivedAt != null;

  const load = useCallback(async (id: number, keepForm = false) => {
    const result = await reviewPeekAction(id);
    if (latest.current !== id) return; // another review was opened meanwhile
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setLoadError(null);
    setData(result.data);
    if (!keepForm) {
      const next = toReviewForm(result.data.review);
      setInitial(next);
      setForm(next);
    }
  }, []);

  const reset = useCallback(() => {
    latest.current = null;
    setTarget(null);
    setData(null);
    setInitial(null);
    setForm(null);
    setErrors({});
    setFormError(null);
    setLoadError(null);
    setGuard(null);
  }, []);

  const show = useCallback(
    (id: number, returnFocus?: () => HTMLElement | null) => {
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      latest.current = id;
      setSheet(window.matchMedia(SHEET_QUERY).matches);
      setTarget({ id, returnFocus: returnFocus ?? (() => opener), pathname: window.location.pathname });
      setData(null);
      setInitial(null);
      setForm(null);
      setErrors({});
      setFormError(null);
      setLoadError(null);
      setGuard(null);
      setPeekParam(id);
      void load(id);
    },
    [load],
  );

  const close = useCallback(() => {
    const focusBack = target?.returnFocus;
    reset();
    setPeekParam(null);
    // after the dialog has closed (the browser may move focus itself first)
    requestAnimationFrame(() => focusBack?.()?.focus());
  }, [reset, target]);

  /** Run `then` now, or after the owner agrees to drop unsaved edits. */
  const guarded = useCallback(
    (then: () => void) => {
      if (dirty) setGuard({ then });
      else then();
    },
    [dirty],
  );

  useImperativeHandle(
    ref,
    () => ({
      open(id, returnFocus) {
        if (target?.id === id) {
          dialogRef.current?.focus();
          return;
        }
        if (target) guarded(() => show(id, returnFocus));
        else show(id, returnFocus);
      },
    }),
    [target, guarded, show],
  );

  const openFull = useCallback(() => {
    if (!target) return;
    const id = target.id;
    guarded(() => {
      reset();
      router.push(`/reviews/${id}`);
    });
  }, [target, guarded, reset, router]);

  function save() {
    if (!form || !review || !dirty || pending) return;
    if (!formRef.current?.reportValidity()) return;
    setErrors({});
    setFormError(null);
    const id = review.id;
    startTransition(async () => {
      const result = await updateReviewAction(id, form, review.updatedAt);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setFormError(result.error);
        return;
      }
      toast('저장했습니다.');
      window.dispatchEvent(new Event(OPS_EVENTS.reviewsChanged));
      await load(id);
    });
  }

  // Open / close the native dialog to match state; modal only for the phone sheet.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (target && !dialog.open) {
      if (sheet) dialog.showModal();
      else dialog.show();
      dialog.focus();
    }
    if (!target && dialog.open) dialog.close();
  }, [target, sheet]);

  // Leaving the page (e.g. a sidebar link) closes the peek (state adjusted during render, not in an effect).
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    if (target && target.pathname !== pathname) setTarget(null);
  }

  // Refresh / shared link: ?peek=<id> reopens it once on load.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    const id = Number(new URLSearchParams(window.location.search).get('peek'));
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const frame = requestAnimationFrame(() => {
      restored.current = true;
      show(id);
    });
    return () => cancelAnimationFrame(frame);
  }, [show]);

  // Page-wide keys while open (the desktop panel is non-modal, so focus may be on the page behind).
  const keys = useRef({ save, openFull, close: () => (guard ? setGuard(null) : guarded(close)) });
  useEffect(() => {
    keys.current = { save, openFull, close: () => (guard ? setGuard(null) : guarded(close)) };
  });
  useEffect(() => {
    if (!target) return;
    function onKeyDown(e: KeyboardEvent) {
      const inOtherDialog = e.target instanceof Element && e.target.closest('dialog') && e.target.closest('dialog') !== dialogRef.current;
      if (inOtherDialog || e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        e.preventDefault();
        keys.current.close();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        keys.current.save();
      } else if (mod && e.key === 'Enter') {
        e.preventDefault();
        keys.current.openFull();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [target]);

  // The guard takes focus so Enter/Space answer it and Esc (above) means "keep editing".
  const guardRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (guard) guardRef.current?.focus();
  }, [guard]);

  /** Keep Tab inside the panel (the native modal sheet does this itself, the side panel does not). */
  function trapTab(e: React.KeyboardEvent<HTMLDialogElement>) {
    if (e.key !== 'Tab') return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === e.currentTarget)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const set = <K extends keyof ReviewFormState>(key: K, value: ReviewFormState[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));
  const today = todayInSeoul();
  const late: CalendarField[] = review && !archived ? overdueFields(review, today) : [];
  const stage = stages.find((s) => String(s.id) === form?.stageId);
  const embargoWarning =
    form?.embargoUntil && form.publishPlannedOn && form.publishPlannedOn < form.embargoUntil
      ? `발행 예정일이 엠바고(${formatDateShort(form.embargoUntil, today)}) 전입니다.`
      : null;

  const field = (name: keyof ReviewFormState) => ({
    id: `${uid}-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? `${uid}-${name}-error` : undefined,
  });
  const error = (name: keyof ReviewFormState) =>
    errors[name] ? (
      <p id={`${uid}-${name}-error`} className="mt-1 text-[12px] text-danger">
        {errors[name]}
      </p>
    ) : null;
  const dateInput = (name: keyof ReviewFormState, label: string, overdue?: CalendarField, extra?: React.ReactNode) => {
    const isLate = overdue !== undefined && late.includes(overdue);
    return (
      <div>
        <label htmlFor={`${uid}-${name}`} className={`label flex items-center gap-1.5 ${isLate ? 'text-danger' : ''}`}>
          {label}
          {isLate ? <OverdueTag /> : null}
        </label>
        <input
          type="date"
          className={`input ${isLate ? 'border-danger/45 text-danger' : ''}`}
          {...field(name)}
          value={form?.[name] as string}
          onChange={(e) => set(name, e.target.value as never)}
        />
        {error(name)}
        {extra}
      </div>
    );
  };

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      aria-labelledby={`${uid}-heading`}
      data-peek={sheet ? 'sheet' : 'panel'}
      onKeyDown={trapTab}
      // the modal sheet: the browser's own Esc handling is replaced by the guarded close above
      onCancel={(e) => e.preventDefault()}
      onClick={(e) => {
        if (sheet && e.target === e.currentTarget) keys.current.close();
      }}
      className={`z-40 m-0 max-w-none overflow-hidden border-line-strong bg-bg p-0 text-fg outline-none ${
        sheet
          ? 'fixed inset-x-0 top-auto bottom-0 max-h-[88dvh] w-full rounded-t-xl border-t'
          : 'fixed inset-y-0 right-0 left-auto h-dvh max-h-none w-[420px] border-l'
      }`}
    >
      {target ? (
        <div className={`flex flex-col ${sheet ? 'max-h-[88dvh]' : 'h-full'}`}>
          {sheet ? <span aria-hidden className="mx-auto mt-2 block h-1 w-9 shrink-0 rounded-full bg-line-strong" /> : null}
          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-2 pl-4">
            <h2 id={`${uid}-heading`} className="text-[12px] font-medium text-muted">
              빠른 편집
            </h2>
            <button
              type="button"
              className="btn btn-ghost ml-auto h-8 px-2 text-[12px] text-muted hover:text-fg"
              onClick={openFull}
              title="Ctrl/⌘ Enter"
            >
              전체 페이지로 열기
              <IconArrowRight className="size-3.5" />
            </button>
            <button type="button" className="btn btn-ghost h-8 px-2" aria-label="닫기" title="Esc" onClick={() => keys.current.close()}>
              <IconX />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6">
            {loadError ? (
              <p role="alert" className="text-[13px] text-danger">
                {loadError}
              </p>
            ) : !form || !data || !review ? (
              <p className="text-[13px] text-muted" aria-busy="true">
                불러오는 중…
              </p>
            ) : (
              <>
                <form
                  ref={formRef}
                  id={`${uid}-form`}
                  aria-label="리뷰 빠른 편집"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save();
                  }}
                >
                  <fieldset disabled={archived || pending} className="flex min-w-0 flex-col gap-4">
                    {archived ? (
                      <p role="status" className="rounded-md border border-line bg-hover px-3 py-2 text-[13px]">
                        보관된 리뷰입니다. 전체 페이지에서 보관을 해제할 수 있습니다.
                      </p>
                    ) : null}
                    <div>
                      <label htmlFor={`${uid}-productName`} className="sr-only">
                        제품명
                      </label>
                      <input
                        {...field('productName')}
                        className="w-full bg-transparent text-[19px] leading-tight font-bold tracking-tight outline-none placeholder:text-subtle"
                        required
                        maxLength={200}
                        value={form.productName}
                        onChange={(e) => set('productName', e.target.value)}
                      />
                      {error('productName')}
                      {late.length > 0 ? (
                        <p className="mt-2 flex flex-wrap gap-1.5">
                          {late.map((f) => {
                            const date = f === 'write_due' ? review.writeDueOn! : review.publishPlannedOn!;
                            return (
                              <OverdueTag key={f}>
                                {CALENDAR_FIELD_META[f].label} {diffDays(date, today)}일 지남
                              </OverdueTag>
                            );
                          })}
                        </p>
                      ) : null}
                    </div>

                    <div>
                      <label htmlFor={`${uid}-title`} className="label">
                        작업 제목
                      </label>
                      <input
                        {...field('title')}
                        className="input"
                        maxLength={200}
                        placeholder="예: 한 달 써 보고 느낀 점"
                        value={form.title}
                        onChange={(e) => set('title', e.target.value)}
                      />
                      {error('title')}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label htmlFor={`${uid}-stageId`} className="label">
                          단계
                        </label>
                        <span className="input flex items-center gap-1.5 pr-0">
                          <Dot color={stage?.color ?? 'var(--subtle)'} />
                          <select
                            {...field('stageId')}
                            className="h-full min-w-0 flex-1 bg-transparent pr-2 outline-none"
                            value={form.stageId}
                            onChange={(e) => set('stageId', e.target.value)}
                          >
                            {CATEGORY_KEYS.map((c) => (
                              <optgroup key={c} label={CATEGORY_LABEL[c]}>
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
                        </span>
                        {error('stageId')}
                      </div>
                      <div>
                        <label htmlFor={`${uid}-brandId`} className="label">
                          브랜드
                        </label>
                        <select {...field('brandId')} className="input" value={form.brandId} onChange={(e) => set('brandId', e.target.value)}>
                          <option value="">없음</option>
                          {brands.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                          {review.brandId && !brands.some((b) => b.id === review.brandId) ? (
                            <option value={review.brandId}>{review.brandName} (보관됨)</option>
                          ) : null}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`${uid}-sourceType`} className="label">
                          입수 형태
                        </label>
                        <select
                          {...field('sourceType')}
                          className="input"
                          value={form.sourceType}
                          onChange={(e) => set('sourceType', e.target.value)}
                        >
                          <option value="">미정</option>
                          {SOURCE_TYPES.map((s) => (
                            <option key={s} value={s}>
                              {SOURCE_TYPE_LABEL[s]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor={`${uid}-priority`} className="label">
                          우선순위
                        </label>
                        <select {...field('priority')} className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                          {PRIORITIES.map((p) => (
                            <option key={p} value={p}>
                              {PRIORITY_LABEL[p]}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <section aria-labelledby={`${uid}-dates`} className="flex flex-col gap-3">
                      <h3 id={`${uid}-dates`} className="section-title">
                        일정
                      </h3>
                      {dateInput('shootOn', '촬영일')}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label htmlFor={`${uid}-shootStartTime`} className="label">
                            촬영 시작 (선택)
                          </label>
                          <input
                            type="time"
                            className="input"
                            {...field('shootStartTime')}
                            value={form.shootStartTime}
                            onChange={(e) => set('shootStartTime', e.target.value)}
                          />
                          {error('shootStartTime')}
                        </div>
                        <div>
                          <label htmlFor={`${uid}-shootEndTime`} className="label">
                            종료 (선택)
                          </label>
                          <input
                            type="time"
                            className="input"
                            {...field('shootEndTime')}
                            value={form.shootEndTime}
                            onChange={(e) => set('shootEndTime', e.target.value)}
                          />
                          {error('shootEndTime')}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        {dateInput('writeDueOn', '작성 마감', 'write_due')}
                        {dateInput('publishPlannedOn', '발행 예정', 'publish_planned')}
                      </div>
                      {embargoWarning ? <p className="-mt-1 text-[12px] text-warn">{embargoWarning}</p> : null}
                      {dateInput('embargoUntil', '엠바고 (이 날짜 전 발행 금지)')}
                    </section>
                  </fieldset>
                </form>

                {/* its own form: each toggle saves at once, like on the full page */}
                <div className="mt-6">
                  <Checklist
                    // remount on reload so the optimistic list starts from the fresh items
                    key={data.checklist.map((i) => `${i.id}:${i.doneAt ?? ''}`).join('|')}
                    reviewId={review.id}
                    items={data.checklist}
                    readOnly={archived}
                    onChanged={() => load(review.id, true)}
                  />
                </div>
              </>
            )}
          </div>

          <footer className="shrink-0 border-t border-line px-4 py-3">
            {guard ? (
              <div role="alertdialog" aria-labelledby={`${uid}-guard`} className="flex flex-wrap items-center gap-2">
                <p id={`${uid}-guard`} className="mr-auto text-[13px] font-medium">
                  저장하지 않은 변경이 있습니다.
                </p>
                <button ref={guardRef} type="button" className="btn" onClick={() => setGuard(null)}>
                  계속 편집
                </button>
                <button
                  type="button"
                  className="btn border-danger/40 text-danger"
                  onClick={() => {
                    const then = guard.then;
                    setGuard(null);
                    then();
                  }}
                >
                  버리고 닫기
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {formError ? (
                  <div role="alert" className="flex items-center gap-2 text-[13px] text-danger">
                    <span className="mr-auto">{formError}</span>
                    {formError === REVIEW_STALE_MESSAGE ? (
                      <button type="button" className="btn h-8 shrink-0" onClick={() => target && show(target.id, target.returnFocus)}>
                        새로고침
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <div className="flex items-center gap-2">
                  <span className="mr-auto text-[12px] text-muted">
                    {dirty ? '저장하지 않은 변경' : <span className="text-subtle">Ctrl/⌘ S 저장 · Esc 닫기</span>}
                  </span>
                  <button type="button" className="btn btn-ghost" onClick={() => keys.current.close()}>
                    닫기
                  </button>
                  <button type="submit" form={`${uid}-form`} className="btn btn-primary" disabled={!dirty || pending || archived}>
                    {pending ? '저장 중…' : '저장'}
                  </button>
                </div>
              </div>
            )}
          </footer>
        </div>
      ) : null}
    </dialog>
  );
}
