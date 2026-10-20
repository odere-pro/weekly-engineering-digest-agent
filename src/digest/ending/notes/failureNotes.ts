import type { Delivery, FailureNote } from '../../../delivery/Delivery';
import { errorMessage } from '../../../shared/errors';
import type { Logger } from '../../../shared/telemetry';
import type { RunRecord } from '../../../store/runRecord';
import { forEachDelivery } from '../shipping/shipping';
import type { EndingContext, Failure } from '../types';
import { isUnretriable } from './unretriable';

export function failureNote(weekId: string, failure: Failure): FailureNote {
  return { weekId, step: failure.step, message: errorMessage(failure.error) };
}

/** Whether the note of this failure waits for a retry: only a run that failed, and can be retried. */
function holdsNote(ctx: EndingContext, failure: Failure | undefined): boolean {
  if (ctx.notifyFailure !== false || failure === undefined) return false;
  return !isUnretriable(errorMessage(failure.error));
}

/**
 * The note that ends a run: sent, or held back for a caller that will try the run again (see
 * `holdsNote`). `failure` is the run's failure, if it failed. A dry run sends none either way.
 */
export async function sendOrHoldNote(
  ctx: EndingContext,
  note: FailureNote | undefined,
  failure: Failure | undefined,
): Promise<void> {
  if (!note || ctx.dryRun) return;
  if (!holdsNote(ctx, failure)) return sendFailureNote(ctx, note);
  ctx.logger.info('Failure note held back: notifyFailure is off for this run', {
    step: failure?.step,
  });
}

/**
 * Sends the note a failed run held back (`notifyFailure: false`) once its caller knows no retry
 * will follow. It is the note the run would have sent: the week, and the step and message in the
 * record. Best effort, like every failure note. A record of a dry run sends none.
 */
export async function sendHeldNote(
  { deliveries, logger }: { readonly deliveries: readonly Delivery[]; readonly logger: Logger },
  weekId: string,
  record: RunRecord,
): Promise<void> {
  if (record.dryRun) return;
  const { error } = record;
  const note = failureNote(weekId, {
    error: error?.message ?? 'The run ended failed',
    step: error?.step,
  });
  await broadcastNote(deliveries, logger, note);
}

/** Best effort: a channel that cannot take the note is logged, the run outcome stands. */
export async function sendFailureNote(ctx: EndingContext, note: FailureNote): Promise<void> {
  if (ctx.dryRun) return;
  await broadcastNote(ctx.deps.deliveries, ctx.logger, note);
}

/**
 * Asks every channel to take back the week's failure note (`Delivery.clearFailure`): the week is
 * sent now. `endRun` calls it once a sent record is saved, so a resume, which does not write the
 * Markdown file again, leaves no stale `<week>.failed.md`. A channel that fails is logged.
 */
export async function clearFailureNotes(ctx: EndingContext): Promise<void> {
  const failures = await forEachDelivery(ctx.deps.deliveries, (delivery) =>
    delivery.clearFailure(ctx.weekId),
  );
  for (const failure of failures) {
    ctx.logger.error('Could not clear the failure note', {
      delivery: failure.id,
      error: failure.error,
    });
  }
}

/** Every channel gets the note; the ones that fail are logged and do not stop the others. */
async function broadcastNote(
  deliveries: readonly Delivery[],
  logger: Logger,
  note: FailureNote,
): Promise<void> {
  const failures = await forEachDelivery(deliveries, (delivery) => delivery.sendFailure(note));
  for (const failure of failures) {
    logger.error('Could not send the failure note', {
      delivery: failure.id,
      error: failure.error,
    });
  }
}
