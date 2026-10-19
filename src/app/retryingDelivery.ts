import { deliveryFacts } from '../delivery/adapters/errors/deliveryError';
import type { Delivery } from '../delivery/Delivery';
import { errorMessage } from '../shared/errors';
import { withRetry } from '../shared/retry';
import type { Logger } from '../shared/telemetry';
import { decorate, type MemberRules } from './decorate';
import { isTransientDeliveryError } from './deliveryRetry/transientError';

/** Extra attempts after the first (F13). A longer outage is the scheduler's job: it retries the run. */
const DEFAULT_RETRIES = 2;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 30_000;

export interface DeliveryRetryOptions {
  logger: Logger;
  /** Extra attempts after the first. Default 2. */
  retries?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** One send, tried again while it fails with a transient error. */
type Attempt = <T>(operation: 'sendDigest' | 'sendFailure', send: () => Promise<T>) => Promise<T>;

/** Every member of a delivery channel, and how it is wrapped: the id as it is, each send retried. */
const RETRY_RULES: MemberRules<Delivery, Attempt> = {
  id: (delivery) => delivery.id,
  sendDigest: (delivery, attempt) => (message) =>
    attempt('sendDigest', () => delivery.sendDigest(message)),
  sendFailure: (delivery, attempt) => (note) =>
    attempt('sendFailure', () => delivery.sendFailure(note)),
};

/**
 * The same channel, but a send that fails with a transient error (see `isTransientDeliveryError`)
 * is tried again: 2 retries, 5 s then 10 s. Every other error goes to the caller at once. A
 * message can still go out twice when the server took it and then answered HTTP 429 or 5xx, or
 * SMTP 421, 450 or 451: only the answer says it did not.
 */
export function withDeliveryRetry(delivery: Delivery, options: DeliveryRetryOptions): Delivery {
  const { logger, retries = DEFAULT_RETRIES, sleep } = options;
  const attempt: Attempt = (operation, send) =>
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
  return decorate(delivery, attempt, RETRY_RULES);
}
