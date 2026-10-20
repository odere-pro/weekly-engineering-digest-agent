import type { RunResult } from '../../digest/types';
import { handOver } from './handOver';
import { lockNote } from './noRecordNote';
import type { Attempt, RetryContext, RetryKind, RetryWhere } from './types';

/** An attempt that may be tried again: `lock-held` pays from its own budget, the others from `failed`. */
type Retryable = Extract<Attempt, { error: string }>;

/** Why a retry that held a note back did not come, by what the loop was waiting on. */
const GAVE_UP_REASON: Readonly<Record<Retryable['kind'], string>> = {
  'lock-held': 'another run kept the lock',
  failed: 'the run kept failing',
  threw: 'the run kept throwing',
};

const RETRY_LOGS: Readonly<Record<Retryable['kind'], { retrying: string; gaveUp: string }>> = {
  'lock-held': {
    retrying: 'Another run holds the lock; will retry',
    gaveUp: 'Scheduled run gave up: another run kept the lock',
  },
  failed: {
    retrying: 'The run ended failed; will retry',
    gaveUp: 'Scheduled run gave up: the run kept failing',
  },
  threw: {
    retrying: 'The run threw an error; will retry',
    gaveUp: 'Scheduled run gave up: the run kept throwing',
  },
};

/** The note a week owes when this attempt is its last and left no record: failed runs sent theirs. */
function noteOf(attempt: Retryable, weekId: string): string | undefined {
  if (attempt.kind === 'lock-held') return lockNote(weekId);
  return attempt.kind === 'threw' ? attempt.note : undefined;
}

/**
 * Logs why the week will be tried again and waits. False when it will not be: no retry is asked
 * for, the budget is spent, or stop() came. Then a note an earlier attempt held back is handed
 * over, else, when the budget is spent, the note this attempt carries (a stop() leaves the week
 * to the next start). `used` counts the retries made so far, per budget, and grows by one for
 * each wait.
 */
export async function waitToRetry(
  { settings, budgets, timer, isStopped }: RetryContext,
  attempt: Retryable,
  used: Record<RetryKind, number>,
  owed: RunResult | undefined,
  where: RetryWhere,
): Promise<boolean> {
  const { logger } = settings;
  const { kind, error } = attempt;
  const budget: RetryKind = kind === 'lock-held' ? 'lock-held' : 'failed';
  const { everyMs, max } = budgets[budget];
  // No retry asked for: the "finished" log and the failure note have already said it failed.
  if (kind === 'failed' && max === 0) return false;
  const fields = { ...where, error, ...(owed !== undefined && { noteHeldBack: true }) };
  if (!isStopped() && used[budget] >= max) {
    logger.error(RETRY_LOGS[kind].gaveUp, { ...fields, retries: used[budget] });
    await handOver(settings, owed, where, GAVE_UP_REASON[kind], noteOf(attempt, where.weekId));
    return false;
  }
  if (!isStopped()) {
    const next = { retry: used[budget] + 1, ofMax: max, inMs: everyMs };
    logger.warn(RETRY_LOGS[kind].retrying, {
      ...fields,
      ...next,
      ...(kind !== 'lock-held' && { noteHeldBack: owed !== undefined }),
    });
  }
  if (isStopped() || !(await timer.wait(everyMs))) {
    logger.info('Retry cancelled: the scheduler stopped', { ...where, error });
    await handOver(settings, owed, where, 'the scheduler stopped');
    return false;
  }
  used[budget] += 1;
  return true;
}
