'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { brandCreateSchema, brandUpdateSchema } from '@/lib/validation';
import { createBrand, setBrandArchived, updateBrand } from '../db/brands';
import { getPool } from '../db/pool';
import { NotFoundError } from '../db/reviews';
import { runAction, type ActionResult } from './run';

export async function createBrandAction(raw: unknown): Promise<ActionResult<{ id: number }>> {
  return runAction(brandCreateSchema, raw, async (input) => {
    const id = await createBrand(getPool(), input);
    revalidatePath('/', 'layout');
    return { id };
  });
}

export async function updateBrandAction(raw: unknown): Promise<ActionResult> {
  return runAction(brandUpdateSchema, raw, async (input) => {
    if (!(await updateBrand(getPool(), input))) throw new NotFoundError('brand');
    revalidatePath('/', 'layout');
    return null;
  });
}

export async function setBrandArchivedAction(brandId: number, archived: boolean): Promise<ActionResult> {
  const schema = z.object({ id: z.number().int().positive(), archived: z.boolean() });
  return runAction(schema, { id: brandId, archived }, async (v) => {
    if (!(await setBrandArchived(getPool(), v.id, v.archived))) throw new NotFoundError('brand');
    revalidatePath('/', 'layout');
    return null;
  });
}
