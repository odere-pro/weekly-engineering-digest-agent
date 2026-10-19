import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { PartialFailure } from '../chain/failures';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { winnerMessage } from '../ending/shipping/digestMessage';
import { shipDigest } from '../ending/shipping/shipping';

/**
 * Sends the winning draft to every channel. A channel that fails fails the step after the
 * others were tried, keeping the channels that took it so a rerun sends only to the rest.
 */
export async function deliver(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { winner } = state;
  if (!winner) throw new DigestError('Nothing to deliver: no winning draft', { step: 'deliver' });
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
