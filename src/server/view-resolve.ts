import {
  BASE_PARAM,
  defaultConfig,
  DRAFT_PARAM,
  legacyListDraft,
  parseConfig,
  parseDraftParam,
  sameConfig,
  VIEW_PARAM,
  viewHref,
  type Layout,
  type ViewConfig,
} from '@/lib/views';
import { ViewSqlError } from './db/view-sql';
import type { SavedView, SavedViewSummary } from './db/views';

export type SearchParams = Record<string, string | string[] | undefined>;

export interface ResolvedView {
  layout: Layout;
  /** every view, in tab order (config omitted: the client only needs names) */
  views: SavedViewSummary[];
  /** the open view, as stored now; null only if the layout has no saved view at all (then the default config is shown) */
  view: SavedViewSummary | null;
  /** as saved (or the layout default if the stored document could not be read) */
  saved: ViewConfig;
  /** what the page shows: the unsaved draft from the URL, or the saved config */
  effective: ViewConfig;
  /**
   * The saved version `effective` is based on — the compare-and-set token for 저장. Without a draft
   * it is the open view's current version (an edit that starts now pins it); with a draft it is the
   * draft's own pinned `?base=`, never the current version; null = a draft of unknown base (an old
   * link or a hand-made URL), which is saved only as a new view or after an explicit overwrite prompt.
   */
  base: number | null;
  /** small inline notices: an unknown view id, an unreadable stored config, an invalid draft URL */
  notices: string[];
}

const NOTICE_UNKNOWN_VIEW = '요청한 보기를 찾을 수 없어 기본 보기를 엽니다.';
const NOTICE_NO_VIEW = '저장된 보기가 없어 기본 설정으로 표시합니다.';
const NOTICE_BAD_STORED = '저장된 보기 설정을 읽지 못해 기본 설정으로 표시합니다. 저장하면 이 설정으로 바뀝니다.';
const NOTICE_BAD_DRAFT = '주소에 담긴 보기 설정이 올바르지 않아 저장된 설정으로 표시합니다.';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function parseBase(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 2_147_483_647 ? n : null;
}

/**
 * Which saved view a review page shows, and with which settings. `?v=<id>` picks the view (a view of
 * another layout → `{ redirect }` to its own page; an unknown id opens the layout's first view), `?cfg=`
 * carries unsaved edits (with `?base=`, the version they started from), and on the table the pre-views
 * filter parameters become such edits (with no base). Nothing here throws on bad input: invalid stored
 * or URL configs fall back with a notice.
 */
export function resolveViewFrom(
  all: SavedView[],
  layout: Layout,
  searchParams: SearchParams,
): ResolvedView | { redirect: string } {
  const views = all.map(({ id, layout: l, name, position, version }) => ({ id, layout: l, name, position, version }));
  const notices: string[] = [];

  const requested = first(searchParams[VIEW_PARAM]);
  let view = requested && /^\d{1,10}$/.test(requested) ? all.find((v) => v.id === Number(requested)) : undefined;
  if (view && view.layout !== layout) {
    const extra = Object.fromEntries(
      Object.entries(searchParams)
        .filter(([k]) => k !== VIEW_PARAM)
        .map(([k, v]) => [k, first(v)]),
    );
    return { redirect: viewHref(view.layout, view.id, null, extra) };
  }
  if (requested && !view) notices.push(NOTICE_UNKNOWN_VIEW);
  view ??= all.find((v) => v.layout === layout);

  let saved = defaultConfig(layout);
  if (!view) {
    notices.push(NOTICE_NO_VIEW);
  } else {
    const parsed = parseConfig(layout, view.config);
    if (parsed) saved = parsed;
    else notices.push(NOTICE_BAD_STORED);
  }

  let draft: ViewConfig | null = null;
  let draftBase: number | null = null;
  const rawDraft = first(searchParams[DRAFT_PARAM]);
  if (rawDraft) {
    draft = parseDraftParam(layout, rawDraft);
    if (!draft) notices.push(NOTICE_BAD_DRAFT);
    else draftBase = parseBase(first(searchParams[BASE_PARAM]));
  } else if (layout === 'list') {
    draft = legacyListDraft(saved, Object.fromEntries(Object.entries(searchParams).map(([k, v]) => [k, first(v)])));
  }

  const summary = view ? views.find((v) => v.id === view.id)! : null;
  const dirty = draft !== null && !sameConfig(draft, saved);
  return {
    layout,
    views,
    view: summary,
    saved,
    effective: dirty ? draft! : saved,
    base: dirty ? draftBase : (summary?.version ?? null),
    notices,
  };
}

/**
 * A config the schema accepted but the database still refused (a compiler fence, an impossible date,
 * a data exception — SQLSTATE class 22). Anything else (connection loss, permissions, timeouts) is a
 * real failure and is not hidden behind a fallback.
 */
function isConfigFailure(error: unknown): boolean {
  if (error instanceof ViewSqlError || error instanceof RangeError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('22');
}

/**
 * Run a view page's query at the resolver/query boundary. If the shown config cannot execute, the page
 * falls back exactly like an unreadable config: a draft → the saved settings (draft notice), the saved
 * settings → the layout default (stored notice). Only a fixed reason tag is logged — never the config,
 * the values or the database message.
 */
export async function runViewQuery<T>(
  resolved: ResolvedView,
  run: (config: ViewConfig) => Promise<T>,
): Promise<{ resolved: ResolvedView; result: T }> {
  let current = resolved;
  for (;;) {
    try {
      return { resolved: current, result: await run(current.effective) };
    } catch (error) {
      if (!isConfigFailure(error)) throw error;
      const fallbackDefault = defaultConfig(current.layout);
      if (!sameConfig(current.effective, current.saved)) {
        console.error('views: fallback reason=draft-not-executable');
        current = {
          ...current,
          effective: current.saved,
          base: current.view?.version ?? null,
          notices: [...new Set([...current.notices, NOTICE_BAD_DRAFT])],
        };
      } else if (!sameConfig(current.saved, fallbackDefault)) {
        console.error('views: fallback reason=saved-not-executable');
        current = {
          ...current,
          saved: fallbackDefault,
          effective: fallbackDefault,
          base: current.view?.version ?? null,
          notices: [...new Set([...current.notices, NOTICE_BAD_STORED])],
        };
      } else {
        throw error;
      }
    }
  }
}
