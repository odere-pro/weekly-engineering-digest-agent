import type { Delivery } from '../../ports/Delivery.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** From .env only. */
  password: string;
  from: string;
  /** From config only, never from model output. */
  to: readonly string[];
}

/** Email over the user's own SMTP server (W1-12). */
export function createSmtpDelivery(_options: SmtpOptions): Delivery {
  throw new NotImplementedError('W1-12');
}
