'use client';

import { useState, useTransition } from 'react';
import { Dot } from '@/components/badges';
import { useToast } from '@/components/toast';
import { CATEGORY_KEYS, CATEGORY_LABEL, SOURCE_TYPE_LABEL, SOURCE_TYPES, type CategoryKey, type Stage } from '@/lib/domain/review';
import { createStageAction, updateSettingsAction, updateStageAction, updateTemplateAction } from '@/server/actions/settings';
import type { UserSettings, Theme } from '@/server/db/settings';
import type { ReviewTemplate } from '@/server/db/templates';

const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

function applyThemeClass(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme !== 'system') root.classList.add(theme);
}

export function PreferencesForm({ settings }: { settings: UserSettings }) {
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [state, setState] = useState(settings);

  function update(patch: Partial<UserSettings>) {
    setState((s) => ({ ...s, ...patch }));
    if (patch.theme) applyThemeClass(patch.theme);
    startTransition(async () => {
      const result = await updateSettingsAction(patch);
      toast(result.ok ? '저장했습니다.' : result.error, result.ok ? undefined : { tone: 'error' });
    });
  }

  return (
    <section aria-labelledby="prefs-title">
      <h2 id="prefs-title" className="section-title">
        캘린더와 화면
      </h2>
      <div className="grid gap-5 pt-4 sm:grid-cols-2">
        <div>
          <label htmlFor="pref-week-start" className="label">
            주 시작 요일
          </label>
          <select
            id="pref-week-start"
            className="input"
            value={state.weekStart}
            onChange={(e) => update({ weekStart: Number(e.target.value) })}
          >
            {WEEKDAYS.map((label, i) => (
              <option key={label} value={i}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <fieldset>
          <legend className="label">테마</legend>
          <div className="flex h-9 items-center gap-4 text-[14px]">
            {(
              [
                ['system', '시스템'],
                ['light', '라이트'],
                ['dark', '다크'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1.5">
                <input type="radio" name="theme" checked={state.theme === value} onChange={() => update({ theme: value })} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-[14px]">
          <input type="checkbox" checked={state.showWeekends} onChange={(e) => update({ showWeekends: e.target.checked })} />
          캘린더에 주말 표시
        </label>
        <label className="flex items-center gap-2 text-[14px]">
          <input type="checkbox" checked={state.timeFormat24h} onChange={(e) => update({ timeFormat24h: e.target.checked })} />
          24시간제
        </label>
      </div>
    </section>
  );
}

export function StageSettings({ stages }: { stages: Stage[] }) {
  return (
    <section aria-labelledby="stages-title">
      <h2 id="stages-title" className="section-title">
        단계
        <span className="text-[12px] font-normal text-muted">분류(할 일 · 진행 중 · 완료)는 고정, 단계는 추가·이름 변경 가능</span>
      </h2>
      <div className="grid gap-6 pt-4 sm:grid-cols-3">
        {CATEGORY_KEYS.map((category) => (
          <div key={category}>
            <p className="mb-2 text-[12px] font-medium text-subtle">{CATEGORY_LABEL[category]}</p>
            <ul className="flex flex-col gap-1.5">
              {stages
                .filter((s) => s.categoryKey === category)
                .map((s) => (
                  <li key={`${s.id}-${s.name}-${s.color}`}>
                    <StageRow stage={s} />
                  </li>
                ))}
            </ul>
            <AddStage category={category} />
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-subtle">‘보류’는 완료 분류에 있지만 발행으로 치지 않고 지연 표시도 하지 않습니다.</p>
    </section>
  );
}

function StageRow({ stage }: { stage: Stage }) {
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [name, setName] = useState(stage.name);
  const [color, setColor] = useState(stage.color);

  function save(next: { name: string; color: string }) {
    if (next.name.trim() === stage.name && next.color === stage.color) return;
    startTransition(async () => {
      const result = await updateStageAction({ id: stage.id, ...next });
      if (!result.ok) {
        toast(result.error, { tone: 'error' });
        setName(stage.name);
        setColor(stage.color);
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={`${stage.name} 색`}
        className="size-6 shrink-0 cursor-pointer rounded border border-line bg-transparent p-0"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        onBlur={() => save({ name, color })}
      />
      <input
        aria-label="단계 이름"
        className="input h-8 text-[13px]"
        maxLength={40}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => save({ name, color })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {stage.isOnHold ? <span className="shrink-0 text-[11px] text-subtle">보류</span> : null}
      {stage.isDefault ? <span className="shrink-0 text-[11px] text-subtle">기본</span> : null}
    </div>
  );
}

function AddStage({ category }: { category: CategoryKey }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  return (
    <form
      className="mt-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await createStageAction({ categoryKey: category, name });
          if (!result.ok) return toast(result.error, { tone: 'error' });
          setName('');
        });
      }}
    >
      <label htmlFor={`add-stage-${category}`} className="sr-only">
        {CATEGORY_LABEL[category]}에 단계 추가
      </label>
      <input
        id={`add-stage-${category}`}
        className="input h-8 text-[13px]"
        placeholder="+ 단계 추가"
        maxLength={40}
        disabled={pending}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
    </form>
  );
}

export function TemplateSettings({ templates, stages }: { templates: ReviewTemplate[]; stages: Stage[] }) {
  return (
    <section aria-labelledby="templates-title">
      <h2 id="templates-title" className="section-title">
        리뷰 템플릿
        <span className="text-[12px] font-normal text-muted">새 리뷰의 단계·마감일·체크리스트를 미리 채웁니다</span>
      </h2>
      <div className="divide-y divide-line">
        {templates.map((t) => (
          <TemplateForm key={t.id} template={t} stages={stages} />
        ))}
      </div>
    </section>
  );
}

function TemplateForm({ template, stages }: { template: ReviewTemplate; stages: Stage[] }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    name: template.name,
    sourceType: template.sourceType ?? '',
    initialStageId: template.initialStageId ? String(template.initialStageId) : '',
    shootOffsetDays: template.shootOffsetDays?.toString() ?? '',
    writeOffsetDays: template.writeOffsetDays?.toString() ?? '',
    publishOffsetDays: template.publishOffsetDays?.toString() ?? '',
    checklist: template.checklist.join('\n'),
    bodyMd: template.bodyMd,
  });
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await updateTemplateAction({
        id: template.id,
        ...form,
        checklist: form.checklist
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      });
      toast(result.ok ? `‘${form.name}’ 템플릿을 저장했습니다.` : result.error, result.ok ? undefined : { tone: 'error' });
    });
  }

  const offset = (key: 'shootOffsetDays' | 'writeOffsetDays' | 'publishOffsetDays', label: string) => (
    <label className="flex items-center gap-1.5 text-[13px]">
      <span className="text-muted">{label}</span>
      <input
        type="number"
        min={0}
        max={365}
        className="input h-8 w-16 text-right"
        value={form[key]}
        onChange={(e) => set(key, e.target.value)}
      />
      <span className="text-muted">일</span>
    </label>
  );

  return (
    <details className="group py-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[14px] font-medium">
        <span className="text-subtle transition-transform group-open:rotate-90">›</span>
        {template.name}
        <span className="text-[12px] font-normal text-muted">
          {template.sourceType ? SOURCE_TYPE_LABEL[template.sourceType] : ''} · 체크리스트 {template.checklist.length}개
        </span>
      </summary>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-4 pl-4" aria-label={`${template.name} 템플릿`}>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor={`t-${template.id}-name`}>
              이름
            </label>
            <input id={`t-${template.id}-name`} className="input" required value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor={`t-${template.id}-source`}>
              입수 형태
            </label>
            <select id={`t-${template.id}-source`} className="input" value={form.sourceType} onChange={(e) => set('sourceType', e.target.value)}>
              <option value="">없음</option>
              {SOURCE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_TYPE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`t-${template.id}-stage`}>
              시작 단계
            </label>
            <select id={`t-${template.id}-stage`} className="input" value={form.initialStageId} onChange={(e) => set('initialStageId', e.target.value)}>
              <option value="">기본 단계</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset>
          <legend className="label">마감일 계산 (비우면 계산하지 않음)</legend>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {offset('shootOffsetDays', '촬영 = 입고 +')}
            <span className="text-subtle">→</span>
            {offset('writeOffsetDays', '작성 마감 = 촬영 +')}
            <span className="text-subtle">→</span>
            {offset('publishOffsetDays', '발행 예정 = 작성 마감 +')}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={`t-${template.id}-checklist`}>
              체크리스트 (한 줄에 하나)
            </label>
            <textarea
              id={`t-${template.id}-checklist`}
              className="input min-h-32 text-[13px]"
              value={form.checklist}
              onChange={(e) => set('checklist', e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor={`t-${template.id}-body`}>
              메모 초안 (마크다운)
            </label>
            <textarea
              id={`t-${template.id}-body`}
              className="input min-h-32 font-mono text-[13px]"
              value={form.bodyMd}
              onChange={(e) => set('bodyMd', e.target.value)}
            />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            템플릿 저장
          </button>
          <span className="flex items-center gap-1.5 text-[12px] text-subtle">
            <Dot color="var(--subtle)" className="size-1.5" />
            이미 만든 리뷰에는 영향이 없습니다
          </span>
        </div>
      </form>
    </details>
  );
}
