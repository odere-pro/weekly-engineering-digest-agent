import { DigestError, errorMessage } from '../../../shared/errors';
import type { StepName } from '../../../domain/schemas';

/** What the failure of a run whose signal fired starts with; `abortedError`, `abortedDuring` write it. */
const ABORTED_PREFIX = 'Run aborted';

/** What a resume that only `digest run --force` can clear says; see `resume/resumeDelivery.ts`. */
const NEEDS_FORCE = '--force';

/**
 * The failure of a run whose signal fired (W5-06, F46): `next` is the step it was about to start.
 * Runs check the signal between steps; a step that got the signal stops within one call, see
 * `abortedDuring`. Nothing when the signal has not fired.
 */
export function abortedError(
  signal: AbortSignal | undefined,
  next?: StepName,
): DigestError | undefined {
  return abortFailure(signal, next, next === undefined ? '' : ` before the ${next} step`);
}

/**
 * The failure of a step that was running when the signal fired: the collect step and the guards
 * stop within one call and throw whatever the aborted call threw, so the step wrapper swaps that
 * for this error. It starts like `abortedError`, so `isUnretriable` holds and no retry follows.
 * Nothing when the signal has not fired.
 */
export function abortedDuring(
  signal: AbortSignal | undefined,
  step: StepName,
): DigestError | undefined {
  return abortFailure(signal, step, ` during the ${step} step`);
}

function abortFailure(
  signal: AbortSignal | undefined,
  step: StepName | undefined,
  where: string,
): DigestError | undefined {
  if (!signal?.aborted) return undefined;
  return new DigestError(`${ABORTED_PREFIX}${where}: ${errorMessage(signal.reason)}`, {
    step,
    cause: signal.reason,
  });
}

/** True for the message of a failure that no retry can clear: a person has to run with --force. */
export function needsForce(message: string | undefined): boolean {
  return message?.includes(NEEDS_FORCE) ?? false;
}

/**
 * True for the recorded error of a failure that no retry follows: the run was told to stop (a
 * timeout, a second signal) or only `digest run --force` can clear it. Such a run sends its note
 * whatever `notifyFailure` says. It goes by the error, never by the run's signal, so a caller
 * that reads the run's record decides exactly as the run did.
 */
export function isUnretriable(message: string | undefined): boolean {
  return needsForce(message) || (message?.startsWith(ABORTED_PREFIX) ?? false);
}
