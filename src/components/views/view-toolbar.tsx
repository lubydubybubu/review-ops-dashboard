'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { countRules, GROUP_PROP_LABEL, PROPERTIES_FOR } from '@/lib/view-config';
import { Dialog } from '../dialog';
import { IconSliders, IconX } from '../icons';
import { Popover } from '../popover';
import { useView } from './view-context';
import type { Section } from './view-editor';
import { NameForm } from './view-tabs';

const loadEditor = () => import('./view-editor');
/** The editors load when a section first opens (or on hover / focus of its button, to hide the wait). */
const SectionBody = dynamic(() => loadEditor().then((m) => m.SectionBody), {
  ssr: false,
  loading: () => <p className="py-1 text-subtle">불러오는 중…</p>,
});
const preloadEditor = () => void loadEditor();

const SECTION_LABEL: Record<Section, string> = { filter: '필터', sort: '정렬', group: '그룹', properties: '속성' };

type Modal = 'none' | 'overwrite' | 'save-as';

/**
 * The open view's settings: 필터 · 정렬 · 그룹 · 속성 as small popovers (one "보기 옵션" sheet on phones),
 * plus the unsaved-changes state with 저장 / 되돌리기. A calendar has only a filter here (its plotted
 * date fields are the chips in the calendar header). Unsaved edits of unknown base (an old link, a
 * hand-made URL) are saved as a new view or, after an explicit prompt, over the view.
 */
export function ViewToolbar() {
  const { layout, config, dirty, pending, error, stale, notices, view, base, update, revert, save, overwrite, saveAsNew } = useView();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [modal, setModal] = useState<Modal>('none');
  const sections: Section[] = layout === 'calendar' ? ['filter'] : ['filter', 'sort', 'group', 'properties'];
  const rules = countRules(config.filter);
  const imported = base === null;
  const closeModal = () => setModal('none');

  const summary = (s: Section): string => {
    switch (s) {
      case 'filter':
        return rules > 0 ? `필터 ${rules}` : '필터';
      case 'sort':
        return config.sorts.length > 0 ? `정렬 ${config.sorts.length}` : '정렬';
      case 'group':
        return config.groupBy ? `그룹: ${GROUP_PROP_LABEL[config.groupBy]}` : '그룹';
      case 'properties': {
        const hidden = PROPERTIES_FOR[layout].filter((p) => config.hidden.includes(p)).length;
        return hidden > 0 ? `속성 (${hidden}개 숨김)` : '속성';
      }
    }
  };
  const active = (s: Section) =>
    (s === 'filter' && rules > 0) || (s === 'sort' && config.sorts.length > 0) || (s === 'group' && config.groupBy !== null);

  return (
    <div className="mb-4" aria-busy={pending || undefined}>
      <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="보기 도구">
        {/* desktop: one popover per section */}
        {sections.map((s) => (
          <span key={s} className="hidden sm:inline-flex">
            <button
              type="button"
              popoverTarget={`view-${s}`}
              onPointerEnter={preloadEditor}
              onFocus={preloadEditor}
              className={`btn h-8 px-2.5 ${active(s) ? 'border-line-strong text-fg' : 'text-muted'}`}
            >
              {summary(s)}
            </button>
            <Popover id={`view-${s}`} label={SECTION_LABEL[s]} className={s === 'filter' ? 'w-[min(40rem,calc(100vw-1rem))] p-3' : 'w-72 p-3'}>
              <SectionBody section={s} config={config} update={update} />
            </Popover>
          </span>
        ))}
        {/* phones: everything in one bottom sheet */}
        <button
          type="button"
          className="btn h-8 px-2.5 text-muted sm:hidden"
          onPointerEnter={preloadEditor}
          onFocus={preloadEditor}
          onClick={() => setSheetOpen(true)}
        >
          <IconSliders className="size-3.5" />
          보기 옵션
          {rules > 0 || config.sorts.length > 0 ? <span className="text-accent">●</span> : null}
        </button>

        {pending ? <span className="text-[12px] text-subtle">적용 중…</span> : null}

        {dirty && view ? (
          <div className="ml-auto flex items-center gap-1.5" data-view-dirty>
            <span className="text-[12px] font-medium text-warn">저장 안 됨</span>
            <button type="button" className="btn btn-ghost h-8 px-2.5" onClick={revert} disabled={pending}>
              되돌리기
            </button>
            {imported ? (
              <button type="button" className="btn h-8 px-2.5" onClick={() => setModal('save-as')} disabled={pending}>
                새 보기로 저장
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary h-8 px-3"
              onClick={imported ? () => setModal('overwrite') : save}
              disabled={pending}
            >
              저장
            </button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <p className="min-w-0 flex-1">{error}</p>
          {stale ? (
            <span className="flex shrink-0 gap-1.5">
              <button type="button" className="btn h-7 px-2.5 text-fg" onClick={revert} disabled={pending}>
                되돌리기
              </button>
              <button type="button" className="btn h-7 px-2.5 text-fg" onClick={() => setModal('save-as')} disabled={pending}>
                새 보기로 저장
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      {notices.map((n) => (
        <p key={n} role="status" className="mt-2 text-[12px] text-warn" data-view-notice>
          {n}
        </p>
      ))}

      <Dialog
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        label="보기 옵션"
        className="mt-auto mb-0 max-h-[85dvh] w-full! max-w-full! overflow-y-auto rounded-b-none"
      >
        <div className="flex flex-col gap-5 p-4 text-[13px]">
          <div className="flex items-center justify-between">
            <h2 className="text-[15px] font-semibold">보기 옵션</h2>
            <button type="button" className="btn btn-ghost px-2" aria-label="닫기" onClick={() => setSheetOpen(false)}>
              <IconX />
            </button>
          </div>
          {sections.map((s) => (
            <section key={s} aria-label={SECTION_LABEL[s]}>
              <h3 className="mb-2 text-[12px] font-medium text-muted">{SECTION_LABEL[s]}</h3>
              <SectionBody section={s} config={config} update={update} />
            </section>
          ))}
        </div>
      </Dialog>

      <Dialog open={modal === 'overwrite'} onClose={closeModal} label="보기 덮어쓰기">
        {modal === 'overwrite' && view ? (
          <div className="flex flex-col gap-4 p-5">
            <h2 className="text-[15px] font-semibold">‘{view.name}’ 보기를 이 설정으로 덮어쓸까요?</h2>
            <p className="text-[13px] text-muted">
              지금 설정은 링크나 주소에서 열려, 어느 저장 시점에서 시작했는지 알 수 없습니다. 덮어쓰면 이 보기에 지금 저장된 설정이
              이 설정으로 바뀝니다. 기존 보기는 그대로 두려면 새 보기로 저장하세요.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={closeModal} autoFocus>
                취소
              </button>
              <button type="button" className="btn" onClick={() => setModal('save-as')}>
                새 보기로 저장
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pending}
                onClick={() => {
                  closeModal();
                  overwrite();
                }}
              >
                덮어쓰기
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog open={modal === 'save-as'} onClose={closeModal} label="새 보기로 저장">
        {modal === 'save-as' ? (
          <NameForm
            title="새 보기로 저장"
            submitLabel="저장"
            initialName=""
            onCancel={closeModal}
            onSubmit={async (name) => {
              const result = await saveAsNew(name);
              if (result.ok) closeModal();
              return result;
            }}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
