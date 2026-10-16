import type { Delivery } from '../../ports/Delivery.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface MarkdownFileOptions {
  dir: string;
}

/** Always-on delivery: writes <dir>/<weekId>.md (W1-12). */
export function createMarkdownFileDelivery(_options: MarkdownFileOptions): Delivery {
  throw new NotImplementedError('W1-12');
}
