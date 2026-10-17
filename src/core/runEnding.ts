import type { Config } from '../config/schema.js';
import type { Delivery, DigestMessage, FailureNote } from '../ports/Delivery.js';
import type { ArtifactName, RunStore } from '../ports/RunStore.js';
import { DigestError, errorMessage } from '../shared/errors.js';
import type { Logger } from '../shared/telemetry.js';
import { truncate } from '../shared/text.js';
import type { DeliveryId, RunRecord, StepName } from './schemas.js';

const SUBJECT_MAX_CHARS = 120;

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

/** A run file a run built but has not written; see `Ending.artifacts`. */
export interface HeldArtifact {
  readonly name: ArtifactName;
  readonly content: string;
}

/** How a run ends: the record to save, the failure behind it and the note to send. */
export interface Ending {
  readonly record: RunRecord;
  readonly failure?: Failure;
  readonly note?: FailureNote;
  /**
   * Run files held back because an earlier record of the week reached a channel, so they go to
   * the store only when `record` replaces it. Later entries replace earlier ones of the same name.
   */
  readonly artifacts?: readonly HeldArtifact[];
}

export interface DeliveryFailure {
  readonly id: Delivery['id'];
  readonly error: string;
}

/**
 * Ends a run (W2-08): the record, the held artifacts, error.json, the failure note, pruning.
 * `previous` is the week's record before this run; it may stay (see `keepReason`), and then the
 * held artifacts and error.json are dropped with this run's record, so they never describe a run
 * whose record was not saved. Returns the held artifacts that were written, none when the earlier
 * record stayed. Throws only when the record cannot be saved, after a note says so.
 */
export async function endRun(
  ctx: EndingContext,
  { record, failure, note, artifacts = [] }: Ending,
  previous: RunRecord | undefined,
): Promise<ReadonlySet<ArtifactName>> {
  const saved = await saveRecord(ctx, record, previous);
  const written = saved ? await writeHeld(ctx, artifacts) : new Set<ArtifactName>();
  if (failure && saved) await saveErrorFile(ctx, failure, new Date(record.finishedAt));
  await sendFailureNote(ctx, note);
  await pruneOldRuns(ctx);
  const { status, winner, counts } = record;
  ctx.logger.info('Run finished', { status, winner, counts });
  return written;
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
  return new DigestError(`Run aborted${where}: ${errorMessage(signal.reason)}`, {
    step: next,
    cause: signal.reason,
  });
}

/** What `shipDigest` reports: every channel that has the digest, and why the rest failed. */
export interface Shipped {
  /** The channels that already had it, then the ones that took it now. */
  readonly deliveredTo: readonly DeliveryId[];
  /** Set when any channel failed; it names the channels that did get the digest. */
  readonly error?: DigestError;
}

/** Tries every channel; never throws. A rerun sends only to the channels the error leaves out. */
export async function shipDigest(
  channels: readonly Delivery[],
  message: DigestMessage,
  alreadyDelivered: readonly DeliveryId[],
): Promise<Shipped> {
  const failures = await forEachDelivery(channels, (channel) => channel.sendDigest(message));
  const failed = new Set(failures.map((failure) => failure.id));
  const reached = channels.map((channel) => channel.id).filter((id) => !failed.has(id));
  const deliveredTo = [...alreadyDelivered, ...reached];
  return failures.length > 0
    ? { deliveredTo, error: deliveryError(deliveredTo, failures) }
    : { deliveredTo };
}

/** Names the channels that did get the digest; a rerun sends only to the others. */
function deliveryError(
  deliveredTo: readonly DeliveryId[],
  failures: readonly DeliveryFailure[],
): DigestError {
  const detail = failures.map((failure) => `${failure.id} (${failure.error})`).join(', ');
  const done = deliveredTo.length > 0 ? `; delivered on ${deliveredTo.join(', ')}` : '';
  return new DigestError(`Delivery failed on ${detail}${done}`, { step: 'deliver' });
}

/** The message every channel gets: a one-line subject over the digest's Markdown. */
export function digestMessage(weekId: string, headline: string, markdown: string): DigestMessage {
  const oneLine = headline.replace(/\s+/g, ' ').trim();
  const subject = oneLine
    ? `Engineering digest ${weekId}: ${oneLine}`
    : `Engineering digest ${weekId}`;
  return { weekId, subject: truncate(subject, SUBJECT_MAX_CHARS), markdown };
}

/** Every run file is pretty JSON with a trailing newline. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** True when the record was saved, false when the earlier one stayed. Alerts, then throws, when it cannot be saved. */
async function saveRecord(
  ctx: EndingContext,
  record: RunRecord,
  previous: RunRecord | undefined,
): Promise<boolean> {
  const reason = keepReason(previous, record);
  if (reason) {
    ctx.logger.warn(reason, { status: record.status });
    return false;
  }
  try {
    await ctx.deps.store.saveRunRecord(record);
    return true;
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

/** A sent record, or a failed one that some channel took: the week must not be sent from scratch. */
export function reachedAChannel(record: RunRecord | undefined): boolean {
  return record?.status === 'sent' || (record?.deliveredTo?.length ?? 0) > 0;
}

/** Best effort, like error.json: a file that cannot be written is logged and left out of the result. */
async function writeHeld(
  ctx: EndingContext,
  artifacts: readonly HeldArtifact[],
): Promise<ReadonlySet<ArtifactName>> {
  const written = new Set<ArtifactName>();
  for (const { name, content } of artifacts) {
    try {
      await ctx.deps.store.saveArtifact(ctx.weekId, name, content);
      written.add(name);
    } catch (error) {
      ctx.logger.error(`Could not write ${name}`, { error: errorMessage(error) });
    }
  }
  return written;
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
