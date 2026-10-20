import type { DeliveryId } from '../../delivery/deliveryId';
import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import type { RunRecord } from '../../store/runRecord';
import { PartialFailure } from '../chain/failures';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { DELIVERY_CUT_OFF, saveProgress } from '../ending/saveProgress';
import { winnerMessage } from '../ending/shipping/digestMessage';
import { stopBeforeSending } from '../ending/shipping/sendGuard';
import { shipDigest } from '../ending/shipping/shipping';
import { buildRecord } from '../record/buildRecord';

/**
 * Sends the winning draft to every channel. A channel that fails fails the step after the
 * others were tried, keeping the channels that took it so a rerun sends only to the rest.
 * Right before it sends, it fails with `Run aborted` when the run lost its lock or was told to
 * stop, or when another run delivered the week meanwhile (`stopBeforeSending`). A started send
 * goes to every channel; after each one that takes it the record of the delivery so far is saved
 * (`saveProgress`), so a run killed mid-delivery is resumed, not sent again to every channel.
 */
export async function deliver(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { winner } = state;
  if (!winner) throw new DigestError('Nothing to deliver: no winning draft', { step: 'deliver' });
  const urls = winner.draft.digest.items.map((item) => item.url);
  const message = winnerMessage(ctx, winner, state.fallback === true, state.eligible);
  const stopped = await stopBeforeSending(ctx, ctx.previousRecord, logger);
  if (stopped) throw stopped;
  const progress = (soFar: readonly DeliveryId[]): Promise<void> =>
    saveProgress(ctx, progressRecord(ctx, state, soFar, urls), ctx.previousRecord, state.held);
  const shipped = await shipDigest(ctx.deps.deliveries, message, state.deliveredTo, progress);
  const { deliveredTo, error } = shipped;
  // Any channel that took the digest counts its URLs as sent, for cross-week dedupe.
  const next = { ...state, deliveredTo, sentUrls: deliveredTo.length > 0 ? urls : [] };
  if (error) throw new PartialFailure(next, error);
  logger.info('Digest delivered', { channels: deliveredTo });
  return next;
}

/**
 * The record of a delivery under way: failed, with the channels that have the digest so far. It
 * ends when it began: the run has not finished, and a run that dies never does.
 */
function progressRecord(
  ctx: RunContext,
  state: ChainState,
  deliveredTo: readonly DeliveryId[],
  sentUrls: readonly string[],
): RunRecord {
  const cutOff = new DigestError(DELIVERY_CUT_OFF, { step: 'deliver' });
  const outcome = {
    state: { ...state, deliveredTo, sentUrls },
    failure: { error: cutOff, step: 'deliver' as const },
  };
  return buildRecord(ctx, outcome, 'failed', ctx.startedAt);
}
