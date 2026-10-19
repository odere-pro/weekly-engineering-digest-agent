import type { RunResult } from '../../digest/runDigest';
import { errorMessage } from '../../shared/errors';
import type { AttemptSettings, RetryWhere } from './types';

const SENDING_HELD_NOTE = 'Sending the failure note held back for a retry that will not run';

/**
 * The retry a failed attempt held its note for is not coming: hand the failed result to
 * `onGiveUp`, which sends the note. Nothing is owed when no attempt held one. A hook that fails is
 * logged, never thrown: the service must stay up.
 */
export async function handOver(
  { onGiveUp, logger }: Pick<AttemptSettings, 'onGiveUp' | 'logger'>,
  owed: RunResult | undefined,
  { weekId, trigger }: RetryWhere,
  reason: string,
): Promise<void> {
  if (owed === undefined || onGiveUp === undefined) return;
  logger.warn(SENDING_HELD_NOTE, { weekId, trigger, reason });
  try {
    await onGiveUp(weekId, owed);
  } catch (error) {
    logger.error('Could not send the failure note held back', {
      weekId,
      trigger,
      error: errorMessage(error),
    });
  }
}
