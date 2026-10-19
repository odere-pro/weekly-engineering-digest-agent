import type { Delivery } from '../Delivery';
import { DeliveryError } from './errors/deliveryError';
import { failureOneLiner } from './errors/failureNote';
import { redactedError, redactSecrets } from './errors/redact';
import { toSlackMrkdwn } from './slackBlocks/slackFormat';
import { toSlackBlocks, type SlackMessage } from './slackBlocks/toSlackBlocks';

const REQUEST_TIMEOUT_MS = 15_000;

/** Blocks when the digest was laid out, plain mrkdwn text otherwise (and for failure notes). */
type SlackPayload = SlackMessage | { text: string };

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

  async function post(payload: SlackPayload): Promise<void> {
    if (!isHttps(options.webhookUrl)) throw new Error('Slack webhook URL must use https');
    let response: Response;
    try {
      response = await send(options.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The message must not carry the URL: its path is the secret. We never add it, and this
        // removes it from any text that echoes it. A Slack webhook URL (https host, then
        // /services/T../B../token) has no character that JSON or Slack escaping rewrites, so the
        // serialized body still contains it verbatim and stays valid JSON after the replacement.
        body: redactSecrets(JSON.stringify(payload), secrets),
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
    sendDigest: (message) =>
      post(message.view ? toSlackBlocks(message.view) : { text: toSlackMrkdwn(message.markdown) }),
    sendFailure: (note) =>
      post({ text: toSlackMrkdwn(redactSecrets(failureOneLiner(note), secrets)) }),
  };
}
