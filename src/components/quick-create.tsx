'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { applyTemplateOffsets, type TemplateOffsets } from '@/lib/domain/templates';
import { ANCHOR_FIELD_LABEL, ANCHOR_FIELDS, SOURCE_TYPE_LABEL, type AnchorField } from '@/lib/domain/review';
import { createReviewAction } from '@/server/actions/reviews';
import { Dialog } from './dialog';
import { OPS_EVENTS, useShell, type QuickCreatePrefill } from './shell-context';
import { useToast } from './toast';

interface FormState {
  productName: string;
  templateId: string;
  stageId: string;
  brandId: string;
  anchorField: AnchorField;
  anchorDate: string;
}

export function QuickCreateDialog({
  open,
  prefill,
  onClose,
}: {
  open: boolean;
  prefill: QuickCreatePrefill;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} label="새 리뷰">
      {/* the dialog unmounts its content when closed, so each opening starts from the prefill */}
      <QuickCreateForm prefill={prefill} onClose={onClose} />
    </Dialog>
  );
}

function QuickCreateForm({ prefill, onClose }: { prefill: QuickCreatePrefill; onClose: () => void }) {
  const { stages, templates, brands } = useShell();
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({
    productName: prefill.productName ?? '',
    templateId: '',
    stageId: '',
    brandId: '',
    anchorField: prefill.anchorField ?? 'shoot',
    anchorDate: prefill.anchorDate ?? '',
  });
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const template = templates.find((t) => String(t.id) === form.templateId);
  const defaultStage = stages.find((s) => s.id === template?.initialStageId) ?? stages.find((s) => s.isDefault);
  const preview = previewDates(form, template);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createReviewAction({
        productName: form.productName,
        templateId: form.templateId,
        stageId: form.stageId,
        brandId: form.brandId,
        anchorField: form.anchorDate ? form.anchorField : '',
        anchorDate: form.anchorDate,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      window.dispatchEvent(new Event(OPS_EVENTS.reviewsChanged));
      router.refresh();
      toast(`‘${form.productName.trim()}’ 리뷰를 만들었습니다.`, {
        action: { label: '열기', href: `/reviews/${result.data.id}` },
      });
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-5" aria-label="새 리뷰 만들기">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">새 리뷰</h2>
        <span className="text-[12px] text-subtle">
          <kbd className="kbd">Enter</kbd> 저장 · <kbd className="kbd">Esc</kbd> 취소
        </span>
      </div>

      <div>
        <label htmlFor="qc-product" className="label">
          제품명
        </label>
        <input
          id="qc-product"
          name="productName"
          className="input"
          autoFocus
          autoComplete="off"
          required
          maxLength={200}
          placeholder="예: Northwind NX7 무선 헤드폰"
          value={form.productName}
          onChange={(e) => set('productName', e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="qc-template" className="label">
            템플릿
          </label>
          <select
            id="qc-template"
            className="input"
            value={form.templateId}
            onChange={(e) => set('templateId', e.target.value)}
          >
            <option value="">없음</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.sourceType ? ` (${SOURCE_TYPE_LABEL[t.sourceType]})` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="qc-brand" className="label">
            브랜드
          </label>
          <select id="qc-brand" className="input" value={form.brandId} onChange={(e) => set('brandId', e.target.value)}>
            <option value="">없음</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="qc-field" className="label">
            날짜 종류
          </label>
          <select
            id="qc-field"
            className="input"
            value={form.anchorField}
            onChange={(e) => set('anchorField', e.target.value as AnchorField)}
          >
            {ANCHOR_FIELDS.map((f) => (
              <option key={f} value={f}>
                {ANCHOR_FIELD_LABEL[f]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="qc-date" className="label">
            날짜
          </label>
          <input
            id="qc-date"
            type="date"
            className="input"
            value={form.anchorDate}
            onChange={(e) => set('anchorDate', e.target.value)}
          />
        </div>
        <div className="col-span-2">
          <label htmlFor="qc-stage" className="label">
            단계
          </label>
          <select id="qc-stage" className="input" value={form.stageId} onChange={(e) => set('stageId', e.target.value)}>
            <option value="">{defaultStage ? `기본값 (${defaultStage.name})` : '기본값'}</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {preview ? (
        <p className="text-[12px] text-muted" data-testid="qc-preview">
          {preview}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          취소
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? '저장 중…' : '만들기'}
        </button>
      </div>
    </form>
  );
}

/** "촬영 10.20 → 작성 마감 10.24 → 발행 예정 10.26" from the template chain. */
function previewDates(form: FormState, offsets: TemplateOffsets | undefined): string | null {
  if (!form.anchorDate || !offsets) return null;
  const key = ({ received: 'receivedOn', shoot: 'shootOn', write_due: 'writeDueOn', publish_planned: 'publishPlannedOn' } as const)[
    form.anchorField
  ];
  const d = applyTemplateOffsets({ [key]: form.anchorDate }, offsets);
  const parts: string[] = [];
  const fmt = (v: string) => `${Number(v.slice(5, 7))}.${Number(v.slice(8, 10))}`;
  if (d.receivedOn) parts.push(`입고 ${fmt(d.receivedOn)}`);
  if (d.shootOn) parts.push(`촬영 ${fmt(d.shootOn)}`);
  if (d.writeDueOn) parts.push(`작성 마감 ${fmt(d.writeDueOn)}`);
  if (d.publishPlannedOn) parts.push(`발행 예정 ${fmt(d.publishPlannedOn)}`);
  return parts.length > 1 ? `템플릿 일정: ${parts.join(' → ')}` : null;
}
