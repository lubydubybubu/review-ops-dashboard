import { z } from 'zod';
import { CATEGORY_KEYS } from './domain/review';
import { isoDate } from './validation';

export const SORT_KEYS = ['product', 'brand', 'stage', 'priority', 'received', 'shoot', 'write_due', 'publish_planned', 'updated'] as const;
export const FILTER_FIELDS = ['received', 'shoot', 'write_due', 'publish_planned', 'embargo'] as const;

/**
 * The review table's state lives in the URL (shareable, back-button friendly). Invalid
 * values are dropped rather than erroring: a hand-edited URL just shows more rows.
 */
export const reviewFilterParams = z.object({
  q: z.string().trim().max(100).optional().catch(undefined),
  stage: z.coerce.number().int().positive().optional().catch(undefined),
  category: z.enum(CATEGORY_KEYS).optional().catch(undefined),
  brand: z.coerce.number().int().positive().optional().catch(undefined),
  field: z.enum(FILTER_FIELDS).optional().catch(undefined),
  from: isoDate.optional().catch(undefined),
  to: isoDate.optional().catch(undefined),
  sort: z.enum(SORT_KEYS).optional().catch(undefined),
  dir: z.enum(['asc', 'desc']).optional().catch(undefined),
  archived: z.literal('1').optional().catch(undefined),
});
export type ReviewFilterParams = z.infer<typeof reviewFilterParams>;

export function parseFilterParams(raw: Record<string, string | string[] | undefined>): ReviewFilterParams {
  const flat = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  return reviewFilterParams.parse(flat);
}

export function filterHref(params: ReviewFilterParams, patch: Partial<Record<keyof ReviewFilterParams, string | number | undefined>>): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...patch })) {
    if (value !== undefined && value !== '') next.set(key, String(value));
  }
  const qs = next.toString();
  return qs ? `/reviews?${qs}` : '/reviews';
}
