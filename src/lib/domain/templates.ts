import { addDays } from './dates';
import type { ReviewDates } from './review';

export interface TemplateOffsets {
  /** shoot = received + n */
  shootOffsetDays: number | null;
  /** write-by = shoot + n */
  writeOffsetDays: number | null;
  /** publish = write-by + n */
  publishOffsetDays: number | null;
}

/**
 * Fill missing dates by walking the template's deadline chain forward
 * (입고 → 촬영 → 작성 마감 → 발행 예정). Dates the user entered are never overwritten,
 * and a link is skipped when its anchor or offset is missing.
 */
export function applyTemplateOffsets(dates: Partial<ReviewDates>, offsets: TemplateOffsets): ReviewDates {
  const receivedOn = dates.receivedOn ?? null;

  const shootOn =
    dates.shootOn ??
    (receivedOn && offsets.shootOffsetDays !== null ? addDays(receivedOn, offsets.shootOffsetDays) : null);

  const writeDueOn =
    dates.writeDueOn ??
    (shootOn && offsets.writeOffsetDays !== null ? addDays(shootOn, offsets.writeOffsetDays) : null);

  const publishPlannedOn =
    dates.publishPlannedOn ??
    (writeDueOn && offsets.publishOffsetDays !== null ? addDays(writeDueOn, offsets.publishOffsetDays) : null);

  return { receivedOn, shootOn, writeDueOn, publishPlannedOn };
}
