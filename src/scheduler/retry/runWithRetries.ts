import type { RunResult } from '../../digest/runDigest';
import { attemptRun } from './attemptRun';
import { handOver } from './handOver';
import type { RetryContext, RetryKind, Trigger } from './types';
import { waitToRetry } from './waitToRetry';

/** Tries again after the wait of the reason's budget, until the budget is spent or stop() came. */
export async function runWithRetries(
  context: RetryContext,
  weekId: string,
  trigger: Trigger,
): Promise<void> {
  const { settings, budgets, isStopped } = context;
  const where = { weekId, trigger };
  const used: Record<RetryKind, number> = { 'lock-held': 0, failed: 0 };
  // The failed result whose note an attempt of this tick held back, until a later run settles it.
  let owed: RunResult | undefined;
  for (;;) {
    // A failure of this attempt is retried while the budget lasts, so its note waits for the last,
    // when there is a hook to send it should the retry not come.
    const holds =
      !isStopped() && used.failed < budgets.failed.max && settings.onGiveUp !== undefined;
    const attempt = await attemptRun(settings, weekId, trigger, { notifyFailure: !holds });
    if (attempt.kind === 'finished') return;
    if (attempt.kind === 'timed-out') {
      await handOver(settings, attempt.owed, where, 'the run hit its time limit');
      return;
    }
    if (attempt.kind === 'threw') {
      // A run that could not save its record sent a note for that, which replaces the held one.
      if (!attempt.noted) await handOver(settings, owed, where, 'the retry threw an error');
      return;
    }
    // A run that met the lock sent no note and leaves the earlier one owed; a failed run decides anew.
    if (attempt.kind === 'failed') owed = attempt.owed;
    if (!(await waitToRetry(context, attempt, used, owed, where))) {
      return;
    }
  }
}
