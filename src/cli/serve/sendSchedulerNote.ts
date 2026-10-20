import type { Delivery, FailureNote } from '../../delivery/Delivery';
import { forEachDelivery } from '../../digest/ending/shipping/shipping';
import type { Logger } from '../../shared/telemetry';

/**
 * Sends a note the scheduler composed (`onNoRecord`) to every channel: a week whose run threw, or
 * never got the lock, has no run record for `sendHeldNote` to read. Best effort like every failure
 * note: a channel that cannot take it is logged and the others still get it. The text is the
 * scheduler's own (the week and an error code or class), so nothing from the cause reaches a channel.
 */
export async function sendSchedulerNote(
  { deliveries, logger }: { readonly deliveries: readonly Delivery[]; readonly logger: Logger },
  weekId: string,
  message: string,
): Promise<void> {
  const note: FailureNote = { weekId, message };
  const failures = await forEachDelivery(deliveries, (delivery) => delivery.sendFailure(note));
  for (const failure of failures) {
    logger.error('Could not send the failure note', {
      delivery: failure.id,
      error: failure.error,
    });
  }
}
