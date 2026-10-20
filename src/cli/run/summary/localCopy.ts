import type { AppHandle } from '../../../app/container';
import type { DigestMessage } from '../../../delivery/Delivery';
import { errorMessage } from '../../../shared/errors';

/** What `saveLocalCopy` did: `error` is set when the write failed. */
export interface LocalCopy {
  written: boolean;
  error?: string;
}

/**
 * Gives the digest to the Markdown channel only (found by `id`), so email and Slack get nothing:
 * a file is not a send. Writes nothing when the app has no markdown channel. Never throws.
 */
export async function saveLocalCopy(app: AppHandle, message: DigestMessage): Promise<LocalCopy> {
  const channel = app.deps.deliveries.find((delivery) => delivery.id === 'markdown');
  if (!channel) return { written: false };
  try {
    await channel.sendDigest(message);
    return { written: true };
  } catch (error) {
    return { written: false, error: errorMessage(error) };
  }
}
