import { z } from 'zod';
import type { Config } from '../config/schema.js';
import type { Delivery, DigestMessage, FailureNote } from '../ports/Delivery.js';
import type { ArtifactName, RunStore } from '../ports/RunStore.js';
import { DigestError, errorMessage } from '../shared/errors.js';
import type { Logger } from '../shared/telemetry.js';
import { truncate } from '../shared/text.js';
import { buildReviewSheet } from './reviewSheet.js';
import {
  ClassificationSchema,
  DraftSchema,
  ItemSchema,
  type DeliveryId,
  type RunRecord,
  type StepName,
} from './schemas.js';

const SUBJECT_MAX_CHARS = 120;

/** What ending a run needs; the run context of runDigest has it. */
export interface EndingContext {
  readonly weekId: string;
  /** A dry run sends no failure note. */
  readonly dryRun: boolean;
  /**
   * False holds back the failure note of a run that failed, for a caller that will try the run
   * again (`RunOptions.notifyFailure`). Default true. The note is sent anyway when no retry can
   * follow: the failure says the run was told to stop, or that only `digest run --force` can
   * clear it (see `isUnretriable`), and when the run record could not be saved. A held note is
   * the caller's to send (`sendHeldNote`) if the retry it waited for does not happen.
   */
  readonly notifyFailure?: boolean;
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

/** What ending a run reports back to the run. */
export interface Ended {
  /** The held artifacts that were written; none when the week's earlier record stayed. */
  readonly written: ReadonlySet<ArtifactName>;
  /** Why the week's earlier record stayed instead of this run's (see `keepReason`); else absent. */
  readonly kept?: string;
}

export interface DeliveryFailure {
  readonly id: Delivery['id'];
  readonly error: string;
}

/**
 * Ends a run (W2-08): the record, the held artifacts, error.json, the failure note, pruning.
 * `previous` is the week's record before this run; it may stay (see `keepReason`), and then the
 * held artifacts and error.json are dropped with this run's record, so they never describe a run
 * whose record was not saved. Returns the held artifacts that were written and, when the earlier
 * record stayed, why. Throws only when the record cannot be saved, after a note says so.
 */
export async function endRun(
  ctx: EndingContext,
  { record, failure, note, artifacts = [] }: Ending,
  previous: RunRecord | undefined,
): Promise<Ended> {
  const kept = keepReason(previous, record);
  const saved = kept === undefined;
  if (saved) await saveRecord(ctx, record);
  else ctx.logger.warn(kept, { status: record.status });
  const written = saved ? await writeHeld(ctx, artifacts) : new Set<ArtifactName>();
  if (saved) await writeReviewSheet(ctx, record, artifacts);
  if (failure && saved) await saveErrorFile(ctx, failure, new Date(record.finishedAt));
  await sendOrHoldNote(ctx, note, failure);
  await pruneOldRuns(ctx);
  const { status, winner, counts } = record;
  ctx.logger.info('Run finished', { status, winner, counts });
  return saved ? { written } : { written, kept };
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

/** What the failure of a run whose signal fired starts with; `abortedError` writes it. */
const ABORTED_PREFIX = 'Run aborted';

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

/**
 * The run record could not be saved. `endRun` has already sent a note saying so, so a caller that
 * held back an earlier attempt's note must not send that one as well.
 */
export class RecordNotSavedError extends DigestError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'RecordNotSavedError';
  }
}

/** Alerts, then throws, when the record cannot be saved. */
async function saveRecord(ctx: EndingContext, record: RunRecord): Promise<void> {
  try {
    await ctx.deps.store.saveRunRecord(record);
  } catch (error) {
    const outcome = record.error ? `failed: ${record.error.message}` : `ended ${record.status}`;
    const message = `Could not save the run record (${errorMessage(error)}); the run ${outcome}`;
    ctx.logger.error('Could not save the run record', { error: errorMessage(error) });
    await sendFailureNote(ctx, { weekId: ctx.weekId, message });
    throw new RecordNotSavedError(message, { cause: error });
  }
}

/** Why a sent week's record stayed: the run may still have reached some channels, then failed. */
export const KEPT_SENT_REASON = 'Kept the sent run record; this forced run did not end sent';
export const KEPT_PARTLY_REASON =
  'Kept the partly delivered run record; this run delivered nothing';

/**
 * A run never replaces a record that got further with delivery. A sent week that looked unsent
 * would be sent again; a partly delivered one that lost its channels would resend to them.
 */
function keepReason(previous: RunRecord | undefined, record: RunRecord): string | undefined {
  if (previous?.status === 'sent') {
    return record.status === 'sent' ? undefined : KEPT_SENT_REASON;
  }
  return reachedAChannel(previous) && !reachedAChannel(record) ? KEPT_PARTLY_REASON : undefined;
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

const ItemsFileSchema = z.array(ItemSchema);
const ScoresFileSchema = z.array(ClassificationSchema);
const DraftsFileSchema = z.object({ drafts: z.array(DraftSchema) });

/**
 * Best effort (W7-07): the sheet a reader ticks to say which picks were wrong and which
 * candidates were missed. Built without a model from the run's files, held or already written.
 * A run with no winner never reached the write step, so it gets none.
 */
async function writeReviewSheet(
  ctx: EndingContext,
  record: RunRecord,
  held: readonly HeldArtifact[],
): Promise<void> {
  if (record.winner === null) return;
  let sheet: string;
  try {
    const read = async (name: ArtifactName): Promise<unknown> => {
      const content =
        held.findLast((artifact) => artifact.name === name)?.content ??
        (await ctx.deps.store.readArtifact(ctx.weekId, name));
      if (content === undefined) throw new Error(`${name} is missing`);
      return JSON.parse(content);
    };
    const items = ItemsFileSchema.parse(await read('items.json'));
    const classifications = ScoresFileSchema.parse(await read('scores.json'));
    const { drafts } = DraftsFileSchema.parse(await read('drafts.json'));
    const winner = drafts.find((draft) => draft.writer === record.winner);
    if (!winner) throw new Error(`no draft by the winner ${record.winner}`);
    const pickedIds = winner.digest.items.map((item) => item.itemId);
    sheet = buildReviewSheet({ weekId: ctx.weekId, items, classifications, pickedIds });
  } catch (error) {
    ctx.logger.warn('Could not build the review sheet', { error: errorMessage(error) });
    return;
  }
  try {
    await ctx.deps.store.saveArtifact(ctx.weekId, 'review.md', sheet);
  } catch (error) {
    ctx.logger.error('Could not write review.md', { error: errorMessage(error) });
  }
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

/** What a resume that only `digest run --force` can clear says; see `runResume.ts`. */
const NEEDS_FORCE = '--force';

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

/** Whether the note of this failure waits for a retry: only a run that failed, and can be retried. */
function holdsNote(ctx: EndingContext, failure: Failure | undefined): boolean {
  if (ctx.notifyFailure !== false || failure === undefined) return false;
  return !isUnretriable(errorMessage(failure.error));
}

/**
 * The note that ends a run: sent, or held back for a caller that will try the run again (see
 * `holdsNote`). `failure` is the run's failure, if it failed. A dry run sends none either way.
 */
async function sendOrHoldNote(
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
async function sendFailureNote(ctx: EndingContext, note: FailureNote): Promise<void> {
  if (ctx.dryRun) return;
  await broadcastNote(ctx.deps.deliveries, ctx.logger, note);
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

async function pruneOldRuns(ctx: EndingContext): Promise<void> {
  try {
    const pruned = await ctx.deps.store.prune(ctx.weekId, ctx.deps.config.keepWeeks);
    if (pruned.length > 0) ctx.logger.info('Pruned old runs', { pruned });
  } catch (error) {
    ctx.logger.error('Could not prune old runs', { error: errorMessage(error) });
  }
}
