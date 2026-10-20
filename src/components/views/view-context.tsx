'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useOptimistic, useState, useTransition } from 'react';
import {
  BASE_PARAM,
  DRAFT_PARAM,
  LEGACY_LIST_PARAMS,
  sameConfig,
  serializeConfig,
  VIEW_PARAM,
  VIEW_STALE_MESSAGE,
  viewHref,
  type Layout,
  type ViewConfig,
} from '@/lib/view-config';
import { createViewAction, saveViewAction } from '@/server/actions/views';
import type { SavedViewSummary } from '@/server/db/views';
import { useToast } from '../toast';
import { ViewTabs } from './view-tabs';

export interface ViewApi {
  layout: Layout;
  views: SavedViewSummary[];
  /** the open view as stored now (its live version) */
  view: SavedViewSummary | null;
  saved: ViewConfig;
  /** what is shown now: unsaved edits applied immediately (optimistic until the server re-renders) */
  config: ViewConfig;
  /** the saved version the unsaved edits started from (null: unknown — an old link or a hand-made URL) */
  base: number | null;
  dirty: boolean;
  pending: boolean;
  error: string | null;
  /** the last save was refused because the view changed elsewhere */
  stale: boolean;
  notices: string[];
  update: (next: ViewConfig) => void;
  revert: () => void;
  /** 저장 onto the open view, compare-and-set on `base` (only when the base is known) */
  save: () => void;
  /** explicit overwrite of a draft without a known base, against the version on screen */
  overwrite: () => void;
  /** 새 보기로 저장: the shown settings become a new view of this layout */
  saveAsNew: (name: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

const ViewContext = createContext<ViewApi | null>(null);

export function useView(): ViewApi {
  const api = useContext(ViewContext);
  if (!api) throw new Error('useView must be used inside <ViewProvider>');
  return api;
}

/**
 * One saved view on a review page. Edits apply at once and live in the URL (`?cfg=`, so a refresh or
 * Back keeps them) together with `?base=`, the saved version the first edit started from. 저장 writes
 * them with that version as the compare-and-set token, so a draft can never silently overwrite what
 * another tab saved in between; only 되돌리기 or a successful save moves the baseline (to the version
 * then on screen). Renders the tab bar; pages place <ViewToolbar/> where it fits.
 */
export function ViewProvider({
  layout,
  views,
  view,
  saved,
  effective,
  base,
  notices,
  children,
}: {
  layout: Layout;
  views: SavedViewSummary[];
  view: SavedViewSummary | null;
  saved: ViewConfig;
  effective: ViewConfig;
  base: number | null;
  notices: string[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [config, setOptimistic] = useOptimistic(effective);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(
    (next: ViewConfig | null) => {
      const url = new URL(window.location.href);
      url.searchParams.delete(DRAFT_PARAM);
      url.searchParams.delete(BASE_PARAM);
      for (const key of LEGACY_LIST_PARAMS) url.searchParams.delete(key);
      if (view) url.searchParams.set(VIEW_PARAM, String(view.id));
      if (next && !sameConfig(next, saved)) {
        url.searchParams.set(DRAFT_PARAM, serializeConfig(next));
        // the draft's baseline: pinned by the first edit (= the version on screen), then carried as is
        if (base !== null) url.searchParams.set(BASE_PARAM, String(base));
      }
      router.replace(`${url.pathname}${url.search}`, { scroll: false });
    },
    [router, saved, view, base],
  );

  const update = useCallback(
    (next: ViewConfig) => {
      setError(null);
      startTransition(() => {
        setOptimistic(next);
        navigate(next);
      });
    },
    [navigate, setOptimistic],
  );

  const revert = useCallback(() => {
    setError(null);
    startTransition(() => {
      setOptimistic(saved);
      navigate(null);
    });
  }, [navigate, saved, setOptimistic]);

  const saveWith = useCallback(
    (expectedVersion: number) => {
      if (!view) return;
      setError(null);
      startTransition(async () => {
        const result = await saveViewAction({ id: view.id, expectedVersion, config });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        toast(`‘${view.name}’ 보기를 저장했습니다.`);
        navigate(null);
      });
    },
    [config, navigate, toast, view],
  );

  const save = useCallback(() => {
    if (base !== null) saveWith(base);
  }, [base, saveWith]);

  const overwrite = useCallback(() => {
    if (view) saveWith(view.version);
  }, [saveWith, view]);

  const saveAsNew = useCallback(
    async (name: string) => {
      const result = await createViewAction({ layout, name, config });
      if (!result.ok) return result;
      setError(null);
      toast(`‘${name.trim()}’ 보기를 만들었습니다.`);
      startTransition(() => router.push(viewHref(layout, result.data.id, null)));
      return { ok: true as const };
    },
    [config, layout, router, toast],
  );

  const api = useMemo<ViewApi>(
    () => ({
      layout,
      views,
      view,
      saved,
      config,
      base,
      dirty: !sameConfig(config, saved),
      pending,
      error,
      stale: error === VIEW_STALE_MESSAGE,
      notices,
      update,
      revert,
      save,
      overwrite,
      saveAsNew,
    }),
    [layout, views, view, saved, config, base, pending, error, notices, update, revert, save, overwrite, saveAsNew],
  );

  return (
    <ViewContext.Provider value={api}>
      <ViewTabs />
      {children}
    </ViewContext.Provider>
  );
}
