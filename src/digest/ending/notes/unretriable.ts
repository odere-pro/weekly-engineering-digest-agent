import { DigestError, errorMessage } from '../../../shared/errors';
import type { StepName } from '../../../domain/schemas';

/** What the failure of a run whose signal fired starts with; `abortedError` writes it. */
const ABORTED_PREFIX = 'Run aborted';

/** What a resume that only `digest run --force` can clear says; see `resume/resumeDelivery.ts`. */
const NEEDS_FORCE = '--force';

/**
 * The failure of a run whose signal fired (W5-06, F46): `next` is the step it was about to start.
 * Runs check the signal between steps, never inside one. Nothing when the signal has not fired.
 */
export function abortedError(
  signal: AbortSignal | undefined,
  next?: StepName,
): DigestError | undefined {
  if (!signal?.aborted) return undefined;
  const where = next === undefined ? '' : ` before the ${next} step`;
  return new DigestError(`${ABORTED_PREFIX}${where}: ${errorMessage(signal.reason)}`, {
    step: next,
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
