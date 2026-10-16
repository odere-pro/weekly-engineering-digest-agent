import type { Digest } from '../schemas.js';
import { NotImplementedError } from '../../shared/errors.js';
import type { CheckResult } from './types.js';

/** 3-5 items, every section present, no em dashes, under 500 words. Always on (W1-11). */
export function formatCheck(_digest: Digest, _markdown: string): CheckResult {
  throw new NotImplementedError('W1-11');
}
