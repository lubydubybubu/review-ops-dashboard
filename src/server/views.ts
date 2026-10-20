import 'server-only';
import { redirect } from 'next/navigation';
import { resolveViewFrom, runViewQuery, type ResolvedView, type SearchParams } from './view-resolve';
import { loadViews } from './queries';

export type { ResolvedView, SearchParams };
export { runViewQuery };

/** The saved view a review page shows (see `resolveViewFrom`); a view of another layout redirects to its page. */
export async function resolveView(layout: ResolvedView['layout'], searchParams: SearchParams): Promise<ResolvedView> {
  const outcome = resolveViewFrom(await loadViews(), layout, searchParams);
  if ('redirect' in outcome) redirect(outcome.redirect);
  return outcome;
}
