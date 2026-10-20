'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { MAIL_STALE_MESSAGE, MAIL_UNDO_EXPIRED_MESSAGE } from '@/lib/mail';
import { mailAcceptSchema, mailDecisionSchema, mailLinkSchema } from '@/lib/validation';
import {
  acceptMailCandidate,
  dismissMailCandidate,
  linkMailCandidate,
  undoDismissMailCandidate,
  type DecisionOutcome,
} from '../db/mail';
import { getPool } from '../db/pool';
import { runAction, type ActionResult } from './run';

/** The badge, the dashboard line and every review view may change: refresh the (small) app. */
function refreshAll() {
  revalidatePath('/', 'layout');
}

function decided<T>(result: ActionResult<DecisionOutcome<T>>): ActionResult<T> {
  if (!result.ok) return result;
  if (!result.data.ok) return { ok: false, error: result.data.error === 'expired' ? MAIL_UNDO_EXPIRED_MESSAGE : MAIL_STALE_MESSAGE };
  refreshAll();
  return { ok: true, data: result.data.data };
}

/** 리뷰로 등록: creates the review (받음 stage) and accepts the candidate in one transaction. */
export async function acceptMailCandidateAction(
  candidateId: number,
  expectedVersion: number,
  raw: unknown,
): Promise<ActionResult<{ reviewId: number; brandCreated: boolean }>> {
  return decided(
    await runAction(
      z.object({ decision: mailDecisionSchema, input: mailAcceptSchema }),
      { decision: { id: candidateId, expectedVersion }, input: raw },
      (v) => acceptMailCandidate(getPool(), v.decision.id, v.decision.expectedVersion, v.input),
    ),
  );
}

/** 기존 리뷰에 연결 */
export async function linkMailCandidateAction(candidateId: number, expectedVersion: number, reviewId: number): Promise<ActionResult> {
  return decided(
    await runAction(mailLinkSchema, { id: candidateId, expectedVersion, reviewId }, (v) =>
      linkMailCandidate(getPool(), v.id, v.expectedVersion, v.reviewId),
    ),
  );
}

/** 무시 (undoable for 7 days) */
export async function dismissMailCandidateAction(candidateId: number, expectedVersion: number): Promise<ActionResult<{ version: number }>> {
  return decided(
    await runAction(mailDecisionSchema, { id: candidateId, expectedVersion }, (v) => dismissMailCandidate(getPool(), v.id, v.expectedVersion)),
  );
}

/** 되돌리기 */
export async function undoDismissMailCandidateAction(candidateId: number, expectedVersion: number): Promise<ActionResult> {
  return decided(
    await runAction(mailDecisionSchema, { id: candidateId, expectedVersion }, (v) =>
      undoDismissMailCandidate(getPool(), v.id, v.expectedVersion),
    ),
  );
}
