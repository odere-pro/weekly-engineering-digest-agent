import type { Delivery, DigestMessage } from '../../../delivery/Delivery';
import type { DeliveryId } from '../../../delivery/deliveryId';
import { DigestError, errorMessage } from '../../../shared/errors';

export interface DeliveryFailure {
  readonly id: Delivery['id'];
  readonly error: string;
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

/** What `shipDigest` reports: every channel that has the digest, and why the rest failed. */
export interface Shipped {
  /** The channels that already had it, then the ones that took it now. */
  readonly deliveredTo: readonly DeliveryId[];
  /** Set when any channel failed; it names the channels that did get the digest. */
  readonly error?: DigestError;
}

/**
 * Told, after each channel that took the digest and before the next is tried, every channel that
 * has it so far. Must not throw: a throw would count a channel that has the digest as failed.
 */
export type OnDelivered = (deliveredTo: readonly DeliveryId[]) => Promise<void>;

/** Tries every channel; never throws. A rerun sends only to the channels the error leaves out. */
export async function shipDigest(
  channels: readonly Delivery[],
  message: DigestMessage,
  alreadyDelivered: readonly DeliveryId[],
  onDelivered?: OnDelivered,
): Promise<Shipped> {
  let soFar = alreadyDelivered;
  const failures = await forEachDelivery(channels, async (channel) => {
    await channel.sendDigest(message);
    soFar = [...soFar, channel.id];
    await onDelivered?.(soFar);
  });
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
