import type { StepName } from '../../../domain/schemas';
import type { DigestError } from '../../../shared/errors';
import type { Logger } from '../../../shared/telemetry';
import type { RunStore } from '../../../store/RunStore';
import type { RunRecord } from '../../../store/runRecord';
import { deliveredMeanwhile } from '../keepReason';
import { abortedError, supersededError } from '../notes/unretriable';

/** What the check before a send needs; a chain run and a resume both have it. */
export interface SendGuardContext {
  readonly weekId: string;
  /** Fires on the caller's stop and on a lost lock (`holdingLock`). */
  readonly signal?: AbortSignal;
  readonly deps: { readonly store: Pick<RunStore, 'getRunRecord'> };
}

const STEP: StepName = 'deliver';

/**
 * Why the run must not start sending, checked last before the first send; none when it may. A run
 * that stalled past the heartbeat timeout may have lost its lock: the run that took it over can
 * have delivered the week already (the store shows it, against `started`, the record this run
 * began from), or the heartbeat has seen the loss and fired the signal. Either stops the send with
 * `Run aborted before the deliver step` (`isUnretriable`). A failed read is thrown, not guessed.
 */
export async function stopBeforeSending(
  ctx: SendGuardContext,
  started: RunRecord | undefined,
  logger: Logger,
): Promise<DigestError | undefined> {
  const stored = await ctx.deps.store.getRunRecord(ctx.weekId);
  if (deliveredMeanwhile(started, stored)) {
    logger.warn('Another run delivered this week', {
      status: stored?.status,
      channels: stored?.deliveredTo,
    });
    return supersededError(ctx.weekId, STEP);
  }
  return abortedError(ctx.signal, STEP);
}
