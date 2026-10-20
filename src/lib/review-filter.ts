import { z } from 'zod';
import { CATEGORY_KEYS } from './domain/review';
import { isoDate } from './validation';
import { hasControlChar, VIEW_DATE_MAX, VIEW_DATE_MIN } from './view-config';

export const SORT_KEYS = ['product', 'brand', 'stage', 'priority', 'received', 'shoot', 'write_due', 'publish_planned', 'updated'] as const;
export const FILTER_FIELDS = ['received', 'shoot', 'write_due', 'publish_planned', 'embargo'] as const;

/**
 * The review table's pre-views query parameters (`/reviews?stage=3`, dashboard / brand links,
 * bookmarks). They now become unsaved edits of the default table view (`legacyListDraft`).
 * Invalid values are dropped rather than erroring: a hand-edited URL just shows more rows. Values
 * follow the view config's executability rules (no control characters, dates in the view range).
 */
const linkDate = isoDate.refine((d) => d >= VIEW_DATE_MIN && d <= VIEW_DATE_MAX);
export const reviewFilterParams = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .refine((s) => !hasControlChar(s))
    .optional()
    .catch(undefined),
  stage: z.coerce.number().int().positive().optional().catch(undefined),
  category: z.enum(CATEGORY_KEYS).optional().catch(undefined),
  brand: z.coerce.number().int().positive().optional().catch(undefined),
  field: z.enum(FILTER_FIELDS).optional().catch(undefined),
  from: linkDate.optional().catch(undefined),
  to: linkDate.optional().catch(undefined),
  sort: z.enum(SORT_KEYS).optional().catch(undefined),
  dir: z.enum(['asc', 'desc']).optional().catch(undefined),
  archived: z.literal('1').optional().catch(undefined),
});
export type ReviewFilterParams = z.infer<typeof reviewFilterParams>;
