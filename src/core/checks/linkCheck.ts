import type { Digest, Item } from '../schemas.js';
import { NotImplementedError } from '../../shared/errors.js';
import type { CheckResult } from './types.js';

/** Every URL in the digest (fields and rendered markdown) must exist in the collected items. Always on (W1-11). */
export function linkCheck(
  _digest: Digest,
  _markdown: string,
  _items: readonly Item[],
): CheckResult {
  throw new NotImplementedError('W1-11');
}
