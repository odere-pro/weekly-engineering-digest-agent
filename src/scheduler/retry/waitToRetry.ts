import type { RunResult } from '../../digest/runDigest';
import { handOver } from './handOver';
import type { Attempt, RetryContext, RetryKind, RetryWhere } from './types';

/** Why a retry that held a note back did not come, by what the loop was waiting on. */
const GAVE_UP_REASON: Readonly<Record<RetryKind, string>> = {
  'lock-held': 'another run kept the lock',
  failed: 'the run kept failing',
};

const RETRY_LOGS: Readonly<Record<RetryKind, { retrying: string; gaveUp: string }>> = {
  'lock-held': {
    retrying: 'Another run holds the lock; will retry',
    gaveUp: 'Scheduled run gave up: another run kept the lock',
  },
  failed: {
    retrying: 'The run ended failed; will retry',
    gaveUp: 'Scheduled run gave up: the run kept failing',
  },
};

/**
 * Logs why the week will be tried again and waits. False when it will not be: no retry is asked
 * for, the budget is spent, or stop() came. Then a note an earlier attempt held back is handed
 * over. `used` counts the retries made so far, per reason, and grows by one for each wait.
 */
export async function waitToRetry(
  { settings, budgets, timer, isStopped }: RetryContext,
  attempt: Extract<Attempt, { error: string }>,
  used: Record<RetryKind, number>,
  owed: RunResult | undefined,
  where: RetryWhere,
): Promise<boolean> {
  const { logger } = settings;
  const { kind, error } = attempt;
  const { everyMs, max } = budgets[kind];
  // No retry asked for: the "finished" log and the failure note have already said it failed.
  if (kind === 'failed' && max === 0) return false;
  const fields = { ...where, error, ...(owed !== undefined && { noteHeldBack: true }) };
  if (!isStopped() && used[kind] >= max) {
    logger.error(RETRY_LOGS[kind].gaveUp, { ...fields, retries: used[kind] });
    await handOver(settings, owed, where, GAVE_UP_REASON[kind]);
    return false;
  }
  if (!isStopped()) {
    const next = { retry: used[kind] + 1, ofMax: max, inMs: everyMs };
    logger.warn(RETRY_LOGS[kind].retrying, {
      ...fields,
      ...next,
      ...(kind === 'failed' && { noteHeldBack: owed !== undefined }),
    });
  }
  if (isStopped() || !(await timer.wait(everyMs))) {
    logger.info('Retry cancelled: the scheduler stopped', { ...where, error });
    await handOver(settings, owed, where, 'the scheduler stopped');
    return false;
  }
  used[kind] += 1;
  return true;
}
