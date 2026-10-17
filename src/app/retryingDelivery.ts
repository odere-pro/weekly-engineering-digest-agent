import { deliveryFacts } from '../adapters/delivery/deliveryError.js';
import type { Delivery } from '../ports/Delivery.js';
import { errorMessage } from '../shared/errors.js';
import { withRetry } from '../shared/retry.js';
import type { Logger } from '../shared/telemetry.js';

/** Extra attempts after the first (F13). A longer outage is the scheduler's job: it retries the run. */
const DEFAULT_RETRIES = 2;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 30_000;

/**
 * Failures that happen while connecting, before the first byte of the message is written: the
 * channel cannot have the message, so sending again cannot double it. nodemailer's own codes
 * (`EDNS`) and the system codes it keeps under them (`originalCode`) are both read.
 */
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EDNS',
  'UND_ERR_CONNECT_TIMEOUT',
]);
/** nodemailer's timeouts that hit before MAIL FROM. A `SOCKET_TIMEOUT` can come after the body. */
const CONNECT_PHASE_TIMEOUTS: ReadonlySet<string> = new Set([
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
]);
/**
 * SMTP replies that say the server did not take the message and may be asked again: 421 (service
 * closing), 450 (mailbox busy), 451 (local error). An answer arrived, so nothing was accepted.
 */
const TRANSIENT_SMTP_REPLIES: ReadonlySet<number> = new Set([421, 450, 451]);
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_FROM = 500;
const HTTP_SERVER_ERROR_TO = 599;

/**
 * True when sending the same message again cannot put a second copy in the channel: the failure
 * came before the message was written (connecting), or the server answered that it did not take
 * it (HTTP 429 or 5xx, SMTP 421, 450 or 451). Decided by the typed facts of the error (see
 * `DeliveryError`), never by its message. A reset or a timeout after the body went out is not
 * retried, because the channel may already have the message.
 */
export function isTransientDeliveryError(error: unknown): boolean {
  const { status, responseCode, code, originalCode, timeoutType } = deliveryFacts(error);
  if (status !== undefined) return isRetryableHttpStatus(status);
  if (responseCode !== undefined) return TRANSIENT_SMTP_REPLIES.has(responseCode);
  if (timeoutType !== undefined) return CONNECT_PHASE_TIMEOUTS.has(timeoutType);
  return [code, originalCode].some((each) => each !== undefined && CONNECT_PHASE_CODES.has(each));
}

function isRetryableHttpStatus(status: number): boolean {
  return (
    status === HTTP_TOO_MANY_REQUESTS ||
    (status >= HTTP_SERVER_ERROR_FROM && status <= HTTP_SERVER_ERROR_TO)
  );
}

export interface DeliveryRetryOptions {
  logger: Logger;
  /** Extra attempts after the first. Default 2. */
  retries?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The same channel, but a send that fails with a transient error (see `isTransientDeliveryError`)
 * is tried again: 2 retries, 5 s then 10 s. Every other error goes to the caller at once. A
 * message can still go out twice when the server took it and then answered HTTP 429 or 5xx, or
 * SMTP 421, 450 or 451: only the answer says it did not.
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
        const { code, status, responseCode } = deliveryFacts(error);
        logger.warn('Delivery failed with a transient error; will retry', {
          delivery: delivery.id,
          operation,
          retry: tried + 1,
          ofMax: retries,
          error: errorMessage(error),
          code,
          status,
          responseCode,
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
