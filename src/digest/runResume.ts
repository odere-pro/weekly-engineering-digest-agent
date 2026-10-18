// Resuming a partly delivered week (W2-08). Moved out of runDigest.ts by W5-06 (F58).
import type { Delivery, DigestView } from '../delivery/Delivery';
import type { Clock } from '../shared/clock';
import { DigestError, errorMessage } from '../shared/errors';
import type { Tracer } from '../shared/telemetry';
import { truncate } from '../shared/text';
import { buildDigestView } from '../render/layout';
import { readSavedDigest, renderView } from '../render/markdown';
import {
  DraftsFileSchema,
  abortedError,
  digestMessage,
  endRun,
  failureNote,
  recordError,
  shipDigest,
  type EndingContext,
  type Failure,
  type Shipped,
} from './runEnding';
import type { DeliveryId } from '../delivery/deliveryId';
import type { RunRecord } from '../store/runRecord';

/** What a resume needs from the run: the ending context, plus the clock and the tracer. */
export interface ResumeContext extends EndingContext {
  readonly startedAt: Date;
  /** Checked before the delivery starts; see `RunOptions.signal`. */
  readonly signal?: AbortSignal;
  readonly deps: EndingContext['deps'] & { readonly clock: Clock; readonly tracer: Tracer };
}

/** A failed run that reached some channels, and the digest.md saved for the week, if any. */
export interface PartDelivery {
  readonly previous: RunRecord;
  readonly deliveredTo: readonly DeliveryId[];
  readonly markdown: string | undefined;
}

export interface ResumeResult {
  readonly record: RunRecord;
  /** The saved digest, when it was sent or tried to a channel; none otherwise. */
  readonly markdown: string | undefined;
}

/** A parse error can quote the file; a log line needs only the start of it. */
const REASON_MAX_CHARS = 300;

/** The previous run, when it failed after reaching some channels; with its digest.md if saved. */
export async function loadPartDelivery(
  ctx: ResumeContext,
  previous: RunRecord | undefined,
): Promise<PartDelivery | undefined> {
  const deliveredTo = previous?.deliveredTo ?? [];
  if (previous?.status !== 'failed' || deliveredTo.length === 0) return undefined;
  const markdown = await ctx.deps.store.readArtifact(ctx.weekId, 'digest.md');
  return { previous, deliveredTo, markdown };
}

/**
 * Sends the saved digest to the channels the failed run missed: no health check, no model call.
 * The record keeps the previous run's results, with the new outcome, channels and deliver timing.
 */
export async function resumeDelivery(
  ctx: ResumeContext,
  part: PartDelivery,
): Promise<ResumeResult> {
  const { previous, deliveredTo } = part;
  const missing = ctx.deps.deliveries.filter((delivery) => !deliveredTo.includes(delivery.id));
  ctx.logger.info('Resuming the delivery of the saved digest', {
    deliveredTo,
    channels: missing.map((delivery) => delivery.id),
  });
  const verdict = missing.length > 0 ? sendable(ctx, part) : undefined;
  const { shipped, timing } = await deliverStep(ctx, missing, verdict, part);
  const failure: Failure | undefined = shipped.error && { error: shipped.error, step: 'deliver' };

  const { error: _previousError, ...kept } = previous;
  const record: RunRecord = {
    ...kept,
    status: failure ? 'failed' : 'sent',
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: ctx.deps.clock.now().toISOString(),
    timings: [...previous.timings, timing],
    deliveredTo: [...shipped.deliveredTo],
    ...(failure && { error: recordError(failure) }),
  };
  // The record always reached a channel, so the earlier one never stays and `endRun` keeps nothing.
  await endRun(
    ctx,
    { record, failure, note: failure && failureNote(ctx.weekId, failure) },
    previous,
  );
  // The digest is only named when it was sent, or tried, to a channel.
  return { record, markdown: verdict?.ok ? verdict.markdown : undefined };
}

/** The deliver step of a resume, traced, timed and logged like a step of the chain. */
async function deliverStep(
  ctx: ResumeContext,
  missing: readonly Delivery[],
  verdict: Verdict | undefined,
  part: PartDelivery,
): Promise<{ shipped: Shipped; timing: RunRecord['timings'][number] }> {
  const { clock } = ctx.deps;
  const logger = ctx.logger.child({ step: 'deliver' });
  const startedMs = clock.now().getTime();
  const shipped = await traced(ctx, part, () => send(ctx, missing, verdict, part));
  const timing = { step: 'deliver' as const, ms: Math.max(0, clock.now().getTime() - startedMs) };
  if (shipped.error) {
    logger.error('Step failed', { ms: timing.ms, error: errorMessage(shipped.error) });
    return { shipped, timing };
  }
  if (verdict?.ok) {
    logger.info('Digest delivered', {
      channels: shipped.deliveredTo.slice(part.deliveredTo.length),
    });
  }
  logger.info('Step finished', { ms: timing.ms });
  return { shipped, timing };
}

/** Carries what a failed delivery reached out of its span, so the trace shows an error. */
class Shortfall extends Error {
  constructor(readonly shipped: Shipped) {
    super(shipped.error?.message);
    this.name = 'Shortfall';
  }
}

/**
 * Runs the delivery inside the `deliver` span and throws inside it when it failed, like a step of
 * the chain. Whatever fails, the week still gets its record: a broken tracer is a failed delivery.
 */
async function traced(
  ctx: ResumeContext,
  part: PartDelivery,
  send: () => Promise<Shipped>,
): Promise<Shipped> {
  const attributes = { runId: ctx.weekId, step: 'deliver' };
  try {
    return await ctx.deps.tracer.span('deliver', attributes, async () => {
      const shipped = await send();
      if (shipped.error) throw new Shortfall(shipped);
      return shipped;
    });
  } catch (error) {
    if (error instanceof Shortfall) return error.shipped;
    const wrapped = new DigestError(errorMessage(error), { step: 'deliver', cause: error });
    return { deliveredTo: part.deliveredTo, error: wrapped };
  }
}

type Verdict =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly error: DigestError };

/**
 * Whether the delivery may start. With every configured channel served there is nothing to send,
 * so the caller skips this and digest.md does not matter. A run told to stop does not start it.
 */
function sendable(ctx: ResumeContext, part: PartDelivery): Verdict {
  const stopped = abortedError(ctx.signal, 'deliver');
  return stopped ? { ok: false, error: stopped } : verifyDigest(part);
}

/**
 * The view of the saved digest, rebuilt from the winning draft in drafts.json (W8-02); none when
 * it cannot be, and then the channels show the Markdown. It never throws: the week is sent either way.
 */
async function savedView(
  ctx: ResumeContext,
  previous: RunRecord,
  markdown: string,
): Promise<DigestView | undefined> {
  try {
    return await rebuildView(ctx, previous, markdown);
  } catch (error) {
    const reason = truncate(errorMessage(error), REASON_MAX_CHARS);
    ctx.logger.warn('Sending the saved digest without its view', { reason });
    return undefined;
  }
}

/**
 * The draft must render to the very digest.md the other channels got. A file saved by an older
 * layout, or a drafts.json from another run, would otherwise send this channel a different digest.
 */
async function rebuildView(
  ctx: ResumeContext,
  previous: RunRecord,
  markdown: string,
): Promise<DigestView> {
  const file = await ctx.deps.store.readArtifact(ctx.weekId, 'drafts.json');
  if (file === undefined) throw new Error('drafts.json is gone');
  const { drafts } = DraftsFileSchema.parse(JSON.parse(file));
  const winner = drafts.find((draft) => draft.writer === previous.winner);
  if (!winner)
    throw new Error(`drafts.json has no draft by the winner ${previous.winner ?? 'none'}`);
  const view = buildDigestView(winner.digest, { disabledGuards: previous.disabledGuards });
  if (renderView(view) !== markdown) {
    throw new Error('digest.md is not the winning draft as it renders now');
  }
  return view;
}

/** Nothing to send, a refused digest, or the saved digest to the channels that lack it. */
async function send(
  ctx: ResumeContext,
  missing: readonly Delivery[],
  verdict: Verdict | undefined,
  { previous, deliveredTo }: PartDelivery,
): Promise<Shipped> {
  if (verdict === undefined) return { deliveredTo };
  if (!verdict.ok) return { deliveredTo, error: verdict.error };
  const { headline } = readSavedDigest(verdict.markdown);
  const view = await savedView(ctx, previous, verdict.markdown);
  const message = digestMessage(ctx.weekId, headline, verdict.markdown, view);
  return shipDigest(missing, message, deliveredTo);
}

/**
 * The saved digest, when its links are exactly the URLs the other channels got. Held artifacts
 * keep a dry or forced run from replacing digest.md once a channel has it, so this is a backstop:
 * a person decides when it fails, because sending anything else would split the week.
 */
function verifyDigest({ previous, deliveredTo, markdown }: PartDelivery): Verdict {
  const redo = 'run with --force to send a new digest to every channel';
  const refuse = (message: string): Verdict => ({
    ok: false,
    error: new DigestError(`${message}; ${redo}`, { step: 'deliver' }),
  });
  if (markdown === undefined) return refuse('The partly delivered digest.md is gone');
  const links = new Set(readSavedDigest(markdown).urls);
  const sent = new Set(previous.sentUrls);
  if (links.size !== sent.size || [...sent].some((url) => !links.has(url))) {
    return refuse(`digest.md no longer matches the digest ${deliveredTo.join(', ')} got`);
  }
  return { ok: true, markdown };
}
