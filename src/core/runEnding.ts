import type { Config } from '../config/schema.js';
import type { Delivery, FailureNote } from '../ports/Delivery.js';
import type { RunStore } from '../ports/RunStore.js';
import { DigestError, errorMessage } from '../shared/errors.js';
import type { Logger } from '../shared/telemetry.js';
import type { RunRecord, StepName } from './schemas.js';

/** What ending a run needs; the run context of runDigest has it. */
export interface EndingContext {
  readonly weekId: string;
  /** A dry run sends no failure note. */
  readonly dryRun: boolean;
  readonly logger: Logger;
  readonly deps: {
    readonly store: RunStore;
    readonly deliveries: readonly Delivery[];
    readonly config: Pick<Config, 'keepWeeks'>;
  };
}

/** Why a run failed, and the step it failed in when it was in one. */
export interface Failure {
  readonly error: unknown;
  readonly step?: StepName;
}

/** How a run ends: the record to save, the failure behind it and the note to send. */
export interface Ending {
  readonly record: RunRecord;
  readonly failure?: Failure;
  readonly note?: FailureNote;
}

export interface DeliveryFailure {
  readonly id: Delivery['id'];
  readonly error: string;
}

/**
 * Ends a run (W2-08): the record, error.json, the failure note, pruning. `previous` is the
 * week's record before this run; it may stay (see `keepReason`). Throws only when the record
 * cannot be saved, after a note says so.
 */
export async function endRun(
  ctx: EndingContext,
  { record, failure, note }: Ending,
  previous: RunRecord | undefined,
): Promise<void> {
  await saveRecord(ctx, record, previous);
  if (failure) await saveErrorFile(ctx, failure, new Date(record.finishedAt));
  await sendFailureNote(ctx, note);
  await pruneOldRuns(ctx);
  const { status, winner, counts } = record;
  ctx.logger.info('Run finished', { status, winner, counts });
}

export function recordError(failure: Failure): NonNullable<RunRecord['error']> {
  return { message: errorMessage(failure.error), step: failure.step };
}

export function failureNote(weekId: string, failure: Failure): FailureNote {
  return { weekId, step: failure.step, message: errorMessage(failure.error) };
}

/** Sends to each channel in turn; returns the ones that failed instead of throwing. */
export async function forEachDelivery(
  deliveries: readonly Delivery[],
  send: (delivery: Delivery) => Promise<void>,
): Promise<DeliveryFailure[]> {
  const failures: DeliveryFailure[] = [];
  for (const delivery of deliveries) {
    try {
      await send(delivery);
    } catch (error) {
      failures.push({ id: delivery.id, error: errorMessage(error) });
    }
  }
  return failures;
}

/** Every run file is pretty JSON with a trailing newline. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A record that cannot be saved is alerted, then thrown. */
async function saveRecord(
  ctx: EndingContext,
  record: RunRecord,
  previous: RunRecord | undefined,
): Promise<void> {
  const reason = keepReason(previous, record);
  if (reason) {
    ctx.logger.warn(reason, { status: record.status });
    return;
  }
  try {
    await ctx.deps.store.saveRunRecord(record);
  } catch (error) {
    const outcome = record.error ? `failed: ${record.error.message}` : `ended ${record.status}`;
    const message = `Could not save the run record (${errorMessage(error)}); the run ${outcome}`;
    ctx.logger.error('Could not save the run record', { error: errorMessage(error) });
    await sendFailureNote(ctx, { weekId: ctx.weekId, message });
    throw new DigestError(message, { cause: error });
  }
}

/**
 * A run never replaces a record that got further with delivery. A sent week that looked unsent
 * would be sent again; a partly delivered one that lost its channels would resend to them.
 */
function keepReason(previous: RunRecord | undefined, record: RunRecord): string | undefined {
  if (previous?.status === 'sent') {
    return record.status === 'sent'
      ? undefined
      : 'Kept the sent run record; this forced run did not send';
  }
  return reachedAChannel(previous) && !reachedAChannel(record)
    ? 'Kept the partly delivered run record; this run delivered nothing'
    : undefined;
}

function reachedAChannel(record: RunRecord | undefined): boolean {
  return record?.status === 'sent' || (record?.deliveredTo?.length ?? 0) > 0;
}

/** Best effort: run.json already holds the error; this file only adds the stack. */
async function saveErrorFile(ctx: EndingContext, failure: Failure, at: Date): Promise<void> {
  const { error, step } = failure;
  const content = toJson({
    runId: ctx.weekId,
    step,
    name: error instanceof Error ? error.name : 'Error',
    message: errorMessage(error),
    at: at.toISOString(),
    stack: error instanceof Error ? error.stack : undefined,
  });
  try {
    await ctx.deps.store.saveArtifact(ctx.weekId, 'error.json', content);
  } catch (saveError) {
    ctx.logger.error('Could not write error.json', { error: errorMessage(saveError) });
  }
}

/** Best effort: a channel that cannot take the note is logged, the run outcome stands. */
async function sendFailureNote(ctx: EndingContext, note: FailureNote | undefined): Promise<void> {
  if (!note || ctx.dryRun) return;
  const failures = await forEachDelivery(ctx.deps.deliveries, (delivery) =>
    delivery.sendFailure(note),
  );
  for (const failure of failures) {
    ctx.logger.error('Could not send the failure note', {
      delivery: failure.id,
      error: failure.error,
    });
  }
}

async function pruneOldRuns(ctx: EndingContext): Promise<void> {
  try {
    const pruned = await ctx.deps.store.prune(ctx.weekId, ctx.deps.config.keepWeeks);
    if (pruned.length > 0) ctx.logger.info('Pruned old runs', { pruned });
  } catch (error) {
    ctx.logger.error('Could not prune old runs', { error: errorMessage(error) });
  }
}
