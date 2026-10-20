import type { RunResult } from '../../digest/types';
import { isUnretriable, needsForce } from '../../digest/ending/notes/unretriable';
import { RecordNotSavedError } from '../../digest/ending/saveRecord';
import { errorMessage } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { isLockHeldError } from '../../store/lockHeld';
import { startRunLimit } from '../runLimit/runLimit';
import { isLockMissError } from './lockMiss';
import { errorLabel, threwNote } from './noRecordNote';
import type { Attempt, AttemptSettings, RunAttempt, Trigger } from './types';

const FINISHED: Attempt = { kind: 'finished' };

/**
 * One call of `run` under its time limit. Never throws; says whether another attempt may help. A
 * run that throws has no record to report, so the attempt carries the note the week owes if no
 * attempt is left; only a run that could not save its record (`RecordNotSavedError`) owes none, as
 * it sent that note itself. A throw after the time limit fired is not retried.
 */
export async function attemptRun(
  { run, logger, runTimeoutMs }: Pick<AttemptSettings, 'run' | 'logger' | 'runTimeoutMs'>,
  weekId: string,
  trigger: Trigger,
  attempt: RunAttempt,
): Promise<Attempt> {
  const limit = startRunLimit(runTimeoutMs, () => {
    logger.error('Scheduled run hit its time limit; asking it to stop', {
      weekId,
      trigger,
      limitMs: runTimeoutMs,
    });
  });
  try {
    const result = await run(weekId, limit.signal, attempt);
    logger.info('Scheduled run finished', {
      weekId,
      trigger,
      status: result.record.status,
      exitCode: result.exitCode,
    });
    return afterRun(logger, result, {
      weekId,
      trigger,
      timedOut: limit.timedOut(),
      notifyFailure: attempt.notifyFailure,
    });
  } catch (error) {
    if (isLockHeldError(error) || isLockMissError(error)) {
      return { kind: 'lock-held', error: error.message };
    }
    logger.error('Scheduled run failed', { weekId, trigger, error: errorMessage(error) });
    if (error instanceof RecordNotSavedError) return { kind: 'noted' };
    const note = threwNote(weekId, errorLabel(error));
    if (limit.timedOut()) return { kind: 'timed-out', note };
    return { kind: 'threw', error: errorMessage(error), note };
  } finally {
    limit.clear();
  }
}

interface AfterRun {
  weekId: string;
  trigger: Trigger;
  timedOut: boolean;
  /** What the attempt was told: false when the run was to hold its failure note back. */
  notifyFailure: boolean;
}

/**
 * A run that ends `failed` is worth another try, except two kinds: one that hit the time limit
 * (another try would take as long again, and a slow or hung model is not a blip), and a resume
 * that only `digest run --force` can clear. The result carries the note a run held back when it
 * was told to (`notifyFailure` false) and its failure is not one it sends at once
 * (`isUnretriable`); the loop owes that note to the week unless a later run replaces it.
 */
export function afterRun(
  logger: Logger,
  result: RunResult,
  { weekId, trigger, timedOut, notifyFailure }: AfterRun,
): Attempt {
  const { record } = result;
  if (record.status !== 'failed') return FINISHED;
  const message = record.error?.message;
  const owed = !notifyFailure && !isUnretriable(message) ? result : undefined;
  if (timedOut) {
    logger.warn('Not retrying a run that hit its time limit', { weekId, trigger });
    return { kind: 'timed-out', owed };
  }
  if (needsForce(message)) {
    logger.warn('Not retrying: finishing this week needs "digest run --force"', {
      weekId,
      trigger,
      error: message,
    });
    return FINISHED;
  }
  return { kind: 'failed', error: message ?? 'The run ended failed', owed };
}
