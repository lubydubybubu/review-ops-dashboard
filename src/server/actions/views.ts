'use server';

import { revalidatePath } from 'next/cache';
import {
  VIEW_STALE_MESSAGE,
  viewCreateSchema,
  viewIdSchema,
  viewMoveSchema,
  viewRenameSchema,
  viewSaveSchema,
} from '@/lib/views';
import { getPool } from '../db/pool';
import { createView, deleteView, duplicateView, moveView, renameView, saveViewConfig } from '../db/views';
import { runAction, type ActionResult } from './run';

/** Tabs show on every review page and in the palette: refresh the (small) app after any change. */
const refreshAll = () => revalidatePath('/', 'layout');

export async function createViewAction(raw: unknown): Promise<ActionResult<{ id: number }>> {
  return runAction(viewCreateSchema, raw, async (input) => {
    const viewId = await createView(getPool(), input);
    refreshAll();
    return { id: viewId };
  });
}

export async function renameViewAction(raw: unknown): Promise<ActionResult> {
  return runAction(viewRenameSchema, raw, async (input) => {
    await renameView(getPool(), input.id, input.name);
    refreshAll();
    return null;
  });
}

export async function duplicateViewAction(raw: unknown): Promise<ActionResult<{ id: number }>> {
  return runAction(viewIdSchema, raw, async (input) => {
    const viewId = await duplicateView(getPool(), input.id);
    refreshAll();
    return { id: viewId };
  });
}

export async function deleteViewAction(raw: unknown): Promise<ActionResult> {
  const result = await runAction(viewIdSchema, raw, async (input) => {
    const outcome = await deleteView(getPool(), input.id);
    if (outcome.ok) refreshAll();
    return outcome;
  });
  if (!result.ok) return result;
  if (!result.data.ok) return { ok: false, error: '레이아웃마다 보기가 하나는 있어야 합니다. 마지막 보기는 삭제할 수 없습니다.' };
  return { ok: true, data: null };
}

export async function moveViewAction(raw: unknown): Promise<ActionResult> {
  return runAction(viewMoveSchema, raw, async (input) => {
    if (await moveView(getPool(), input.id, input.direction)) refreshAll();
    return null;
  });
}

/** "저장": the config is checked by the zod schema here, compiled from closed maps when it runs. */
export async function saveViewAction(raw: unknown): Promise<ActionResult<{ version: number }>> {
  const result = await runAction(viewSaveSchema, raw, async (input) => {
    const outcome = await saveViewConfig(getPool(), input.id, input.expectedVersion, input.config);
    if (outcome.ok) refreshAll();
    return outcome;
  });
  if (!result.ok) return result;
  if (!result.data.ok) return { ok: false, error: VIEW_STALE_MESSAGE };
  return { ok: true, data: { version: result.data.version } };
}
