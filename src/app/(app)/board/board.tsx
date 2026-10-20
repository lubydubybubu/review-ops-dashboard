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
import { Dot, OverdueTag, StageBadge } from '@/components/badges';
import { PeekLink } from '@/components/peek-link';
import { useToast } from '@/components/toast';
import { useView } from '@/components/views/view-context';
import { formatDateShort, type IsoDate } from '@/lib/domain/dates';
import { overdueFields } from '@/lib/domain/overdue';
import { CATEGORY_LABEL, CHANNEL_LABEL, SOURCE_TYPE_LABEL, type Stage } from '@/lib/domain/review';
import { groupReviews, type ReviewGroup } from '@/lib/view-groups';
import type { PropertyKey } from '@/lib/view-config';
import { moveReviewStageAction } from '@/server/actions/reviews';
import type { ReviewListItem } from '@/server/db/reviews';

/**
 * Columns = the view's group-by options (stages by default). Grouped by stage, dropping a card on
 * another column calls the stage-move action; the card moves immediately (useOptimistic) and snaps
 * back if the server refuses. Other groupings are read-only columns (no drag).
 */
export function Board({ stages, reviews, today }: { stages: Stage[]; reviews: ReviewListItem[]; today: IsoDate }) {
  const { config } = useView();
  const groupBy = config.groupBy ?? 'stage';
  const draggable = groupBy === 'stage';
  const shown = new Set(Object.keys(PROPERTY_SHOWN).filter((p) => !config.hidden.includes(p as PropertyKey)) as PropertyKey[]);
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [dragging, setDragging] = useState<ReviewListItem | null>(null);
  const [optimistic, applyMove] = useOptimistic(reviews, (state, move: { id: number; stageId: number }) =>
    state.map((r) => (r.id === move.id ? { ...r, stageId: move.stageId } : r)),
  );

  const groups = groupReviews(optimistic, groupBy, stages, { includeEmpty: groupBy !== 'brand' });

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
      <div
        className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-4 md:mx-0 md:scroll-px-0 md:px-0"
        data-board-group={groupBy}
      >
        {groups.map((group, i) => (
          <Column
            key={group.key}
            group={group}
            category={
              group.stage && (i === 0 || groups[i - 1]!.stage?.categoryKey !== group.stage.categoryKey)
                ? CATEGORY_LABEL[group.stage.categoryKey]
                : null
            }
            draggable={draggable}
            shown={shown}
            today={today}
          />
        ))}
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging ? <Card review={dragging} today={today} shown={shown} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

/** Card fields a view can hide (the product name always shows). */
const PROPERTY_SHOWN: Partial<Record<PropertyKey, true>> = {
  brand: true,
  stage: true,
  source_type: true,
  priority: true,
  channels: true,
  next_date: true,
};

function Column({
  group,
  category,
  draggable,
  shown,
  today,
}: {
  group: ReviewGroup;
  category: string | null;
  draggable: boolean;
  shown: Set<PropertyKey>;
  today: IsoDate;
}) {
  // only stage columns are drop targets
  const { setNodeRef, isOver } = useDroppable({ id: group.stage ? `stage-${group.stage.id}` : `group-${group.key}`, disabled: !group.stage });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${group.label} (${group.items.length})`}
      data-stage-id={group.stage?.id}
      data-group={group.key}
      className={`flex w-[16rem] shrink-0 snap-start flex-col rounded-lg transition-colors md:w-[15rem] ${isOver ? 'bg-hover' : ''}`}
    >
      <p className={`h-4 px-1 text-[11px] font-medium text-subtle ${category ? '' : 'invisible'}`}>{category}</p>
      <h2 className="flex items-center gap-2 border-b border-line px-1 py-2 text-[13px] font-semibold">
        {group.color ? <Dot color={group.color} /> : null}
        {group.label}
        <span className="font-normal text-subtle tabular-nums" data-group-count>
          {group.items.length}
        </span>
      </h2>
      <ul className="flex min-h-32 flex-1 flex-col gap-1.5 py-2">
        {group.items.map((r) => (
          <li key={r.id}>
            {draggable ? <DraggableCard review={r} today={today} shown={shown} /> : <Card review={r} today={today} shown={shown} still />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DraggableCard({ review, today, shown }: { review: ReviewListItem; today: IsoDate; shown: Set<PropertyKey> }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: review.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? 'opacity-30' : undefined}>
      <Card review={review} today={today} shown={shown} />
    </div>
  );
}

function Card({
  review: r,
  today,
  shown,
  overlay = false,
  still = false,
}: {
  review: ReviewListItem;
  today: IsoDate;
  shown: Set<PropertyKey>;
  overlay?: boolean;
  /** not draggable (a non-stage grouping) */
  still?: boolean;
}) {
  const late = overdueFields(r, today);
  const next = shown.has('next_date') ? nextDate(r, today) : null;
  return (
    <article
      data-review-id={r.id}
      className={`group rounded-md border bg-surface px-3 py-2.5 ${
        late.length > 0 ? 'border-danger/45' : 'border-line'
      } ${overlay ? 'rotate-1 cursor-grabbing border-line-strong' : still ? 'hover:border-line-strong' : 'cursor-grab hover:border-line-strong'}`}
    >
      <PeekLink
        reviewId={r.id}
        className="block text-[13px] leading-snug font-medium hover:underline hover:underline-offset-2"
        draggable={false}
      >
        {r.productName}
      </PeekLink>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
        {shown.has('stage') ? <StageBadge name={r.stageName} color={r.stageColor} onHold={r.isOnHold} /> : null}
        {shown.has('brand') && r.brandName ? <span data-card-field="brand">{r.brandName}</span> : null}
        {shown.has('source_type') && r.sourceType ? <span className="text-subtle">{SOURCE_TYPE_LABEL[r.sourceType]}</span> : null}
        {shown.has('priority') && r.priority === 'high' ? <span className="font-medium text-accent">높음</span> : null}
      </p>
      {shown.has('channels') && r.channels.length > 0 ? (
        <p className="mt-1 text-[11px] text-subtle">{r.channels.map((c) => CHANNEL_LABEL[c]).join(' · ')}</p>
      ) : null}
      {next || late.length > 0 ? (
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
