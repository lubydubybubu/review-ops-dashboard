'use client';

import { createContext, useContext } from 'react';
import type { IsoDate } from '@/lib/domain/dates';
import type { AnchorField, SourceType, Stage } from '@/lib/domain/review';
import type { TemplateOffsets } from '@/lib/domain/templates';
import type { UserSettings } from '@/server/db/settings';

export interface TemplateOption extends TemplateOffsets {
  id: number;
  name: string;
  sourceType: SourceType | null;
  initialStageId: number | null;
}

export interface QuickCreatePrefill {
  productName?: string;
  anchorField?: AnchorField;
  anchorDate?: IsoDate;
  /** 리뷰로 등록 from the mail inbox: the form saves through the candidate (one transaction) */
  mail?: MailPrefill;
}

/** What the mail inbox hands quick create (extracted fields, the owner reviews them before saving). */
export interface MailPrefill {
  candidateId: number;
  /** the candidate version the inbox showed (compare-and-set) */
  version: number;
  subject: string;
  sender: string;
  productName: string;
  brandName: string | null;
  sourceType: SourceType | null;
  writeDueOn: IsoDate | null;
  publishPlannedOn: IsoDate | null;
  embargoUntil: IsoDate | null;
  memo: string;
}

export interface ShellApi {
  stages: Stage[];
  templates: TemplateOption[];
  brands: { id: number; name: string }[];
  settings: UserSettings;
  openQuickCreate: (prefill?: QuickCreatePrefill) => void;
  openPalette: () => void;
  /**
   * Quick-edit peek for one review. `returnFocus` finds the element to focus again on close (the
   * clicked chip/card may have been re-rendered by then); default: whatever had focus when it opened.
   */
  openPeek: (reviewId: number, returnFocus?: () => HTMLElement | null) => void;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const api = useContext(ShellContext);
  if (!api) throw new Error('useShell must be used inside <AppShell>');
  return api;
}

/** Window events that let distant views react to shell-level actions. */
export const OPS_EVENTS = {
  reviewsChanged: 'ops:reviews-changed',
  calendarToday: 'ops:calendar-today',
} as const;
