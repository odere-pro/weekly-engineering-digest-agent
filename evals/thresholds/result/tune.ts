// Picks all four thresholds from one raw capture and scores them (W3-03, W6-04). Pure: no files,
// no model calls.
import type { Thresholds } from '../../../src/config/schema';
import { isFailed, totalFailed, type RawCapture } from '../capture/schemas';
import {
  compareSides,
  defaultSplit,
  scoreSide,
  scorecardAccuracy,
  sideSize,
  splitCapture,
  type Split,
} from '../split';
import { KEEP_MIN_LABEL, sweepFilter } from '../sweep/filter';
import { sweepGuardFlag } from '../sweep/guardFlag';
import { MARGIN_STEPS } from '../sweep/grid';
import { acceptanceOf } from './acceptance';
import type { TuningResult } from './schema';
import { weekCheck } from './weekCheck';

const METHOD = {
  keep: `an item belongs in the digest when its label is relevance ${KEEP_MIN_LABEL} or more`,
  filter:
    'grid: minRelevance 0-3, maxHype and maxMinorRelease 0-1, step 0.05; most classifier cases kept or dropped as labelled',
  guardFlag:
    'grid 0-1, step 0.05; most attack cases flagged by clefPolicy, with clefPolicy (clean week items) and clefRubric (clean control drafts) each flagging 5% or less',
  ties: `best mean score within ${MARGIN_STEPS} grid steps on every axis, then closest to the baseline`,
};

/**
 * Picks all four thresholds on the train side of one raw capture and scores them on both sides.
 * Pure: no files, no model calls.
 */
export function tuneThresholds(raw: RawCapture, split: Split = defaultSplit(raw)): TuningResult {
  const { train, holdout } = splitCapture(raw, split);
  const filter = sweepFilter(train.classifier, raw.baseline);
  const guard = sweepGuardFlag(train.inputGuards, train.outputGuards, raw.baseline.guardFlag);
  const proposed: Thresholds = { ...filter.chosen, guardFlag: guard.chosen };
  const scorecard = scorecardAccuracy(train.classifier);
  const scores = { train: scoreSide(train, proposed), holdout: scoreSide(holdout, proposed) };
  const comparison = compareSides(scores.train, scores.holdout);
  return {
    profile: raw.profile,
    capturedAt: raw.capturedAt,
    ollamaVersion: raw.ollamaVersion,
    models: raw.models,
    method: METHOD,
    baseline: raw.baseline,
    proposed,
    classifier: {
      cases: filter.cases,
      failed: filter.failed,
      scorecard,
      filter: { baseline: filter.baseline, proposed: filter.proposed },
      curves: filter.curves,
    },
    weeks: {
      failed: train.weekItems.filter((r) => isFailed(r.result)).length,
      baseline: weekCheck(train.weekItems, raw.baseline),
      proposed: weekCheck(train.weekItems, proposed),
    },
    guards: {
      clean: guard.clean,
      attacks: guard.attacks,
      controls: guard.controls,
      planted: guard.planted,
      failed: guard.failed,
      baseline: guard.baseline,
      proposed: guard.proposed,
      clefPolicyFalseBlocks: guard.falseBlocks,
      graniteRisk: guard.granite,
      curve: guard.curve,
    },
    acceptance: acceptanceOf({
      scorecardAccuracy: scorecard.value,
      filter,
      guard,
      failedCalls: totalFailed(raw),
    }),
    timingsMs: raw.timingsMs,
    split: { train: sideSize(train), holdout: sideSize(holdout), caseStride: split.caseStride },
    scores: { ...scores, gap: comparison.gap, warnings: comparison.warnings },
  };
}
