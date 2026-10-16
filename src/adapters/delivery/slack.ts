import type { Delivery } from '../../ports/Delivery.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface SlackOptions {
  /** From .env only. */
  webhookUrl: string;
  fetch?: typeof fetch;
}

/** Slack incoming webhook (W1-12). */
export function createSlackDelivery(_options: SlackOptions): Delivery {
  throw new NotImplementedError('W1-12');
}
