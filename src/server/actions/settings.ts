'use server';

import { revalidatePath } from 'next/cache';
import { settingsSchema, stageCreateSchema, stageUpdateSchema, templateUpdateSchema } from '@/lib/validation';
import type { Stage } from '@/lib/domain/review';
import { getPool } from '../db/pool';
import { NotFoundError } from '../db/reviews';
import { updateSettings, type UserSettings } from '../db/settings';
import { createStage, updateStage } from '../db/stages';
import { updateTemplate } from '../db/templates';
import { runAction, type ActionResult } from './run';

export async function updateSettingsAction(raw: unknown): Promise<ActionResult<UserSettings>> {
  return runAction(settingsSchema, raw, async (input) => {
    const settings = await updateSettings(getPool(), input);
    revalidatePath('/', 'layout');
    return settings;
  });
}

export async function createStageAction(raw: unknown): Promise<ActionResult<Stage>> {
  return runAction(stageCreateSchema, raw, async (input) => {
    const stage = await createStage(getPool(), input);
    revalidatePath('/', 'layout');
    return stage;
  });
}

export async function updateStageAction(raw: unknown): Promise<ActionResult> {
  return runAction(stageUpdateSchema, raw, async (input) => {
    if (!(await updateStage(getPool(), input))) throw new NotFoundError('stage');
    revalidatePath('/', 'layout');
    return null;
  });
}

export async function updateTemplateAction(raw: unknown): Promise<ActionResult> {
  return runAction(templateUpdateSchema, raw, async (input) => {
    if (!(await updateTemplate(getPool(), input))) throw new NotFoundError('template');
    revalidatePath('/settings');
    return null;
  });
}
