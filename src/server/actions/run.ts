import 'server-only';
import type { z } from 'zod';
import { fieldErrors } from '@/lib/validation';
import { isTrustedMutation, requireSession } from '../auth/session';
import { friendlyDbError } from '../db/errors';
import { NotFoundError } from '../db/reviews';

export type ActionResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

/**
 * The one shape every server action follows: origin check → session check → zod parse →
 * data layer. Known DB rule violations come back as Korean messages; anything else is logged
 * and reported generically (no internals leak to the client).
 */
export async function runAction<S extends z.ZodType, T>(
  schema: S,
  raw: unknown,
  handler: (input: z.output<S>) => Promise<T>,
): Promise<ActionResult<T>> {
  if (!(await isTrustedMutation())) return { ok: false, error: '요청 출처를 확인할 수 없습니다.' };
  await requireSession();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    return { ok: false, error: Object.values(errors)[0] ?? '입력값을 확인해 주세요.', fieldErrors: errors };
  }
  try {
    return { ok: true, data: await handler(parsed.data) };
  } catch (error) {
    if (error instanceof NotFoundError) return { ok: false, error: '항목을 찾을 수 없습니다.' };
    const message = friendlyDbError(error);
    if (message) return { ok: false, error: message };
    console.error(error);
    return { ok: false, error: '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
}
