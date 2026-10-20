import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { PartialFailure } from '../chain/failures';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { deliveredMeanwhile } from '../ending/keepReason';
import { supersededError } from '../ending/notes/unretriable';
import { winnerMessage } from '../ending/shipping/digestMessage';
import { shipDigest } from '../ending/shipping/shipping';

/**
 * Sends the winning draft to every channel. A channel that fails fails the step after the
 * others were tried, keeping the channels that took it so a rerun sends only to the rest.
 * Before it sends, it fails with `Run aborted` when another run delivered the week meanwhile.
 */
export async function deliver(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { winner } = state;
  if (!winner) throw new DigestError('Nothing to deliver: no winning draft', { step: 'deliver' });
  await assertNotDeliveredMeanwhile(ctx, logger);
  const { items } = winner.draft.digest;
  const message = winnerMessage(ctx, winner, state.fallback === true);
  const { deliveredTo, error } = await shipDigest(ctx.deps.deliveries, message, state.deliveredTo);
  // Any channel that took the digest counts its URLs as sent, for cross-week dedupe.
  const sentUrls = deliveredTo.length > 0 ? items.map((item) => item.url) : [];
  const next = { ...state, deliveredTo, sentUrls };
  if (error) throw new PartialFailure(next, error);
  logger.info('Digest delivered', { channels: deliveredTo });
  return next;
}

/**
 * A run that stalled past the heartbeat timeout loses its lock to a takeover, and the run that took
 * it may have delivered the week by the time this one wakes. The store is the only witness, so
 * look right before sending: the lock itself is not checked (that needs a change to the port).
 */
async function assertNotDeliveredMeanwhile(ctx: RunContext, logger: Logger): Promise<void> {
  const stored = await ctx.deps.store.getRunRecord(ctx.weekId);
  if (!deliveredMeanwhile(ctx.previousRecord, stored)) return;
  logger.warn('Another run delivered this week', {
    status: stored?.status,
    channels: stored?.deliveredTo,
  });
  throw supersededError(ctx.weekId, 'deliver');
}
