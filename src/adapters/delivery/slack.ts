import type { Delivery } from '../../ports/Delivery.js';
import { DeliveryError } from './deliveryError.js';
import { failureOneLiner } from './failureNote.js';
import { redactedError, redactSecrets } from './redact.js';
import { toSlackMrkdwn } from './slackFormat.js';

const REQUEST_TIMEOUT_MS = 15_000;

export interface SlackOptions {
  /** From .env only. */
  webhookUrl: string;
  fetch?: typeof fetch;
}

/** Every spelling of the webhook that an error message could carry: raw, normalized, secret path. */
function webhookSecrets(webhookUrl: string): string[] {
  try {
    const { href, pathname } = new URL(webhookUrl);
    return [webhookUrl, href, pathname.length > 1 ? pathname : ''];
  } catch {
    return [webhookUrl];
  }
}

function isHttps(webhookUrl: string): boolean {
  try {
    return new URL(webhookUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Slack incoming webhook (W1-12). Refuses to post to anything but https. */
export function createSlackDelivery(options: SlackOptions): Delivery {
  const send = options.fetch ?? fetch;
  const secrets = webhookSecrets(options.webhookUrl);

  async function post(text: string): Promise<void> {
    // The message must not carry the URL: its path is the secret.
    if (!isHttps(options.webhookUrl)) throw new Error('Slack webhook URL must use https');
    let response: Response;
    try {
      response = await send(options.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        // Only the configured endpoint may be contacted, so a redirect is a failure.
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw redactedError('Slack webhook request failed', error, secrets);
    }
    if (!response.ok) {
      throw new DeliveryError(`Slack webhook answered HTTP ${String(response.status)}`, {
        status: response.status,
      });
    }
  }

  return {
    id: 'slack',
    sendDigest: (message) => post(toSlackMrkdwn(message.markdown)),
    sendFailure: (note) => post(toSlackMrkdwn(redactSecrets(failureOneLiner(note), secrets))),
  };
}
