'use client';

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useOptimistic, useState, useTransition } from 'react';
import { Dot, OverdueTag } from '@/components/badges';
import { PeekLink } from '@/components/peek-link';
import { useToast } from '@/components/toast';
import { formatDateShort, type IsoDate } from '@/lib/domain/dates';
import { overdueFields } from '@/lib/domain/overdue';
import { CATEGORY_LABEL, SOURCE_TYPE_LABEL, type Stage } from '@/lib/domain/review';
import { moveReviewStageAction } from '@/server/actions/reviews';
import type { ReviewListItem } from '@/server/db/reviews';

/**
 * Columns = stages. Dropping a card on another column calls the stage-move action; the
 * card moves immediately (useOptimistic) and snaps back if the server refuses.
 */
export function Board({ stages, reviews, today }: { stages: Stage[]; reviews: ReviewListItem[]; today: IsoDate }) {
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [dragging, setDragging] = useState<ReviewListItem | null>(null);
  const [optimistic, applyMove] = useOptimistic(reviews, (state, move: { id: number; stageId: number }) =>
    state.map((r) => (r.id === move.id ? { ...r, stageId: move.stageId } : r)),
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );

  function onDragStart(e: DragStartEvent) {
    setDragging(optimistic.find((r) => r.id === e.active.id) ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const reviewId = Number(e.active.id);
    const stageId = e.over ? Number(String(e.over.id).replace('stage-', '')) : null;
    const review = optimistic.find((r) => r.id === reviewId);
    if (!review || stageId === null || review.stageId === stageId) return;
    const target = stages.find((s) => s.id === stageId);

    startTransition(async () => {
      applyMove({ id: reviewId, stageId });
      const result = await moveReviewStageAction({ reviewId, stageId });
      if (!result.ok) toast(result.error, { tone: 'error' });
      else toast(`‘${review.productName}’ → ${target?.name ?? ''}`);
    });
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
      accessibility={{
        screenReaderInstructions: { draggable: '스페이스로 카드를 들고, 화살표로 옮긴 뒤 스페이스로 놓습니다.' },
      }}
    >
      <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 md:mx-0 md:scroll-px-0 md:px-0">
        {stages.map((stage, i) => (
          <Column
            key={stage.id}
            stage={stage}
            showCategory={i === 0 || stages[i - 1]!.categoryKey !== stage.categoryKey}
            reviews={optimistic.filter((r) => r.stageId === stage.id)}
            today={today}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>{dragging ? <Card review={dragging} today={today} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({
  stage,
  showCategory,
  reviews,
  today,
}: {
  stage: Stage;
  showCategory: boolean;
  reviews: ReviewListItem[];
  today: IsoDate;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `stage-${stage.id}` });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${stage.name} (${reviews.length})`}
      data-stage-id={stage.id}
      className={`flex w-[16rem] shrink-0 snap-start flex-col rounded-lg transition-colors md:w-[15rem] ${isOver ? 'bg-hover' : ''}`}
    >
      <p className={`h-4 px-1 text-[11px] font-medium text-subtle ${showCategory ? '' : 'invisible'}`}>
        {CATEGORY_LABEL[stage.categoryKey]}
      </p>
      <h2 className="flex items-center gap-2 border-b border-line px-1 py-2 text-[13px] font-semibold">
        <Dot color={stage.color} />
        {stage.name}
        <span className="font-normal text-subtle tabular-nums">{reviews.length}</span>
      </h2>
      <ul className="flex min-h-32 flex-1 flex-col gap-1.5 py-2">
        {reviews.map((r) => (
          <li key={r.id}>
            <DraggableCard review={r} today={today} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DraggableCard({ review, today }: { review: ReviewListItem; today: IsoDate }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: review.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? 'opacity-30' : undefined}>
      <Card review={review} today={today} />
    </div>
  );
}

function Card({ review: r, today, overlay = false }: { review: ReviewListItem; today: IsoDate; overlay?: boolean }) {
  const late = overdueFields(r, today);
  const next = nextDate(r, today);
  return (
    <article
      data-review-id={r.id}
      className={`group rounded-md border bg-surface px-3 py-2.5 ${
        late.length > 0 ? 'border-danger/45' : 'border-line'
      } ${overlay ? 'rotate-1 cursor-grabbing border-line-strong' : 'cursor-grab hover:border-line-strong'}`}
    >
      <PeekLink
        reviewId={r.id}
        className="block text-[13px] leading-snug font-medium hover:underline hover:underline-offset-2"
        draggable={false}
      >
        {r.productName}
      </PeekLink>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
        {r.brandName ? <span>{r.brandName}</span> : null}
        {r.sourceType ? <span className="text-subtle">{SOURCE_TYPE_LABEL[r.sourceType]}</span> : null}
        {r.priority === 'high' ? <span className="font-medium text-accent">높음</span> : null}
      </p>
      {next ? (
        <p className={`mt-1.5 flex items-center gap-1.5 text-[12px] ${late.length > 0 ? 'text-danger' : 'text-muted'}`}>
          {late.length > 0 ? <OverdueTag /> : null}
          {next}
        </p>
      ) : null}
    </article>
  );
}

/** The most relevant upcoming (or missed) date to show on a card. */
function nextDate(r: ReviewListItem, today: IsoDate): string | null {
  if (r.categoryKey === 'done') return null;
  const candidates: [string, IsoDate | null][] = [
    ['촬영', r.shootOn],
    ['작성 마감', r.writeDueOn],
    ['발행 예정', r.publishPlannedOn],
  ];
  const late = overdueFields(r, today);
  if (late.length > 0) {
    const field = late[0]!;
    const date = field === 'write_due' ? r.writeDueOn! : r.publishPlannedOn!;
    return `${field === 'write_due' ? '작성 마감' : '발행 예정'} ${formatDateShort(date, today)}`;
  }
  const upcoming = candidates.filter(([, d]) => d !== null && d >= today).sort((a, b) => (a[1]! < b[1]! ? -1 : 1))[0];
  return upcoming ? `${upcoming[0]} ${formatDateShort(upcoming[1]!, today)}` : null;
}
