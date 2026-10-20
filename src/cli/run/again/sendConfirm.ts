import type { AppHandle } from '../../../app/container';
import type { DigestMessage } from '../../../delivery/Delivery';
import type { DeliveryId } from '../../../delivery/deliveryId';
import { markVariantSent } from '../../../digest/ending/markSent';
import { shipDigest } from '../../../digest/ending/shipping/shipping';
import type { RunVariant } from '../../../digest/variant';
import { DigestError, errorMessage } from '../../../shared/errors';
import { linkUrls } from './links';
import type { RunPrompts } from './types';

/** What `sendVariant` did: the channels that have the digest, and why the rest do not. */
export interface VariantSend {
  deliveredTo: readonly DeliveryId[];
  error?: DigestError;
}

/** The channels a variant can be sent to: every configured one but the Markdown file. */
export function sendChannelIds(app: AppHandle): DeliveryId[] {
  return app.deps.deliveries.map((channel) => channel.id).filter((id) => id !== 'markdown');
}

/** `Send to email, slack?` Default no; nothing to ask when only the Markdown file is configured. */
export async function confirmSend(
  prompts: RunPrompts,
  ids: readonly DeliveryId[],
): Promise<boolean> {
  if (ids.length === 0) return false;
  return prompts.confirm({ message: `Send to ${ids.join(', ')}?`, default: false });
}

/** The URLs of the variant digest's items: from its view, else from the links in its Markdown. */
function itemUrls(message: DigestMessage): string[] {
  const fromView = message.view?.groups.flatMap((group) => group.items.map((item) => item.url));
  return fromView && fromView.length > 0 ? fromView : linkUrls(message.markdown);
}

/**
 * Sends the variant digest to the non-Markdown channels (the file is already written), then marks
 * the week's record with what went out. Never throws: a failure comes back as `error`.
 */
export async function sendVariant(
  app: AppHandle,
  message: DigestMessage,
  variant: RunVariant,
  weekId: string,
): Promise<VariantSend> {
  const channels = app.deps.deliveries.filter((channel) => channel.id !== 'markdown');
  const shipped = await shipDigest(channels, message, ['markdown']);
  if (shipped.deliveredTo.length <= 1) return shipped;
  try {
    await markVariantSent(app.deps, weekId, shipped.deliveredTo, itemUrls(message), variant);
  } catch (error) {
    const note = `The digest went out, but the week's record could not be updated: ${errorMessage(error)}`;
    return { deliveredTo: shipped.deliveredTo, error: shipped.error ?? new DigestError(note) };
  }
  return shipped;
}
