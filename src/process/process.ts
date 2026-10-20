import type { ScoredItem } from '../classify/classification';
import type { Thresholds } from '../config/schema';
import { calibrateClassification, type Calibration } from './calibration';
import { applyStage, drop } from './filter/applyStage';
import { filterStages } from './filter/filterStages';
import { pickWithAreaSpread } from './rank/pickWithAreaSpread';
import { rankBy } from './rank/rankBy';
import { DigestError } from '../shared/errors';
import type { Dropped, Entry } from './types';

export interface ProcessInput {
  items: readonly ScoredItem[];
  /** URLs already sent in recent weeks. */
  sentUrls: ReadonlySet<string>;
  thresholds: Thresholds;
  topN: number;
  /** When given, relevance is replaced by the calibrated score before filtering and ranking. */
  calibration?: Calibration | undefined;
  /**
   * Item ids in a model-chosen order (W11-07 pairwise experiment). Listed items rank by their
   * position, before any unlisted item. Absent: ranking is unchanged.
   */
  pairwiseOrder?: readonly string[] | undefined;
  /**
   * Normalized URLs of items kept from an earlier run: they win relevance ties, never more.
   * Absent: ranking is unchanged.
   */
  boostUrls?: ReadonlySet<string> | undefined;
}

export interface ProcessOutput {
  selected: ScoredItem[];
  dropped: Dropped[];
  /** The eligible items the top N cut left out, best first: the next picks (PERF-2 backfill). */
  belowTopN: ScoredItem[];
  /** Every item that passed all filters, in rank order: `selected` and `belowTopN` together. */
  eligible: ScoredItem[];
}

/** Pure ranking and filtering in code, no model calls (W1-08). */
export function processStep(input: ProcessInput): ProcessOutput {
  const { sentUrls, thresholds, topN, calibration, pairwiseOrder, boostUrls } = input;
  assertTopN(topN);
  const items = calibration
    ? input.items.map((item) => ({
        ...item,
        classification: calibrateClassification(calibration, item.classification),
      }))
    : input.items;

  // Rank once up front: every later list (drops included) is in rank order, whatever the input order.
  const ranked = items.map((item): Entry => ({ item })).sort(rankBy(pairwiseOrder, boostUrls));
  const { kept: eligible, dropped } = filterStages(sentUrls, thresholds).reduce(applyStage, {
    kept: ranked,
    dropped: [],
  });

  const chosen = pickWithAreaSpread(eligible, topN);
  const selected = eligible.filter((entry) => chosen.has(entry));
  const belowTopN = eligible.filter((entry) => !chosen.has(entry));

  return {
    selected: selected.map(({ item }) => item),
    dropped: [...dropped, ...belowTopN.map(({ item }) => drop(item, 'below-top-n'))],
    belowTopN: belowTopN.map(({ item }) => item),
    eligible: eligible.map(({ item }) => item),
  };
}

function assertTopN(topN: number): void {
  if (!Number.isInteger(topN) || topN < 0) {
    throw new DigestError(`topN must be a non-negative integer, got ${topN}`, {
      step: 'process',
    });
  }
}
