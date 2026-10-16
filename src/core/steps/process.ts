import type { ScoredItem } from '../schemas.js';
import type { Thresholds } from '../../config/schema.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface ProcessInput {
  items: readonly ScoredItem[];
  /** URLs already sent in recent weeks. */
  sentUrls: ReadonlySet<string>;
  thresholds: Thresholds;
  topN: number;
}

export interface ProcessOutput {
  selected: ScoredItem[];
  dropped: {
    itemId: string;
    reason:
      'duplicate' | 'sent-before' | 'low-relevance' | 'hype' | 'minor-release' | 'below-top-n';
  }[];
}

/** Pure ranking and filtering in code, no model calls (W1-08). */
export function processStep(_input: ProcessInput): ProcessOutput {
  throw new NotImplementedError('W1-08');
}
