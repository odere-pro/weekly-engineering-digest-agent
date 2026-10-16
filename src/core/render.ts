import type { Digest, GuardCheckId } from './schemas.js';
import { NotImplementedError } from '../shared/errors.js';

export interface RenderOptions {
  /** Guards that were off this week; named in the footer. */
  disabledGuards: readonly GuardCheckId[];
}

/** Digest -> Markdown (W1-11). */
export function renderDigest(_digest: Digest, _options: RenderOptions): string {
  throw new NotImplementedError('W1-11');
}
