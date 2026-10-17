import type { Delivery } from '../ports/Delivery.js';
import { errorMessage } from '../shared/errors.js';
import { withRetry } from '../shared/retry.js';
import type { Logger } from '../shared/telemetry.js';

/** Extra attempts after the first (F13). A longer outage is the scheduler's job: it retries the run. */
const DEFAULT_RETRIES = 2;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 30_000;

/** Slack: "Slack webhook answered HTTP 503". */
const HTTP_SERVER_ERROR = /\bHTTP 5\d{2}\b/;
/**
 * nodemailer puts the server's reply after a colon: "Mail command failed: 451 4.3.0 ...",
 * "Invalid login: 535 ...", "...all recipients were rejected: 450 ...". A 4yz reply asks the client
 * to try later; a 5yz reply is final. The first digit decides, whatever else the text says.
 */
const SMTP_REPLY = /:\s([45])\d{2}[ -]/;
/**
 * The delivery adapters throw plain errors with the cause stripped (a secret may sit in it), so
 * the message is all there is to read. Each pattern is a failure another attempt can clear.
 */
const NETWORK_PATTERNS: readonly RegExp[] = [
  // Node and undici error codes for a connection that did not happen or did not last.
  /\b(?:ECONN\w+|ETIMEDOUT|ESOCKET\w*|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_\w+)\b/,
  /\b(?:fetch failed|socket hang up|socket (?:close|closed|disconnected)|connection closed)\b/i,
  /\bgreeting never received\b/i,
  // "Connection timeout", "Socket timeout", "connect timed out", "aborted due to timeout".
  /\b(?:connection|socket|connect|dns) time(?:d ?out|out)\b/i,
  /\baborted due to timeout\b/i,
  // A connection error made of several attempts (an AggregateError, e.g. a dual-stack host that
  // refuses both addresses) has no message of its own, so the adapter's prefix ends the text.
  /\b(?:request|delivery) failed:\s*$/,
];

/** True for network errors, timeouts and 5xx answers; false for anything a retry cannot fix. */
export function isTransientDeliveryError(error: unknown): boolean {
  const message = errorMessage(error);
  if (HTTP_SERVER_ERROR.test(message)) return true;
  const reply = SMTP_REPLY.exec(message);
  if (reply) return reply[1] === '4';
  return NETWORK_PATTERNS.some((pattern) => pattern.test(message));
}

export interface DeliveryRetryOptions {
  logger: Logger;
  /** Extra attempts after the first. Default 2. */
  retries?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The same channel, but a send that fails with a transient error is tried again (2 retries, 5 s
 * then 10 s). Every other error goes to the caller at once. A retry can send a message twice
 * when the first try reached the server and only its answer was lost.
 */
export function withDeliveryRetry(delivery: Delivery, options: DeliveryRetryOptions): Delivery {
  const { logger, retries = DEFAULT_RETRIES, sleep } = options;
  const attempt = <T>(
    operation: 'sendDigest' | 'sendFailure',
    send: () => Promise<T>,
  ): Promise<T> =>
    withRetry(send, {
      retries,
      baseDelayMs: BASE_DELAY_MS,
      maxDelayMs: MAX_DELAY_MS,
      shouldRetry: isTransientDeliveryError,
      onRetry: (error, tried) => {
        logger.warn('Delivery failed with a transient error; will retry', {
          delivery: delivery.id,
          operation,
          retry: tried + 1,
          ofMax: retries,
          error: errorMessage(error),
        });
      },
      sleep,
    });
  return {
    id: delivery.id,
    sendDigest: (message) => attempt('sendDigest', () => delivery.sendDigest(message)),
    sendFailure: (note) => attempt('sendFailure', () => delivery.sendFailure(note)),
  };
}
