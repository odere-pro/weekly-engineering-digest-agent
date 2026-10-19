import type { Classification } from '../../classify/classification';
import type { Thresholds } from '../../config/schema';
import type { DropReason } from '../types';

export type ThresholdReason = Extract<DropReason, 'low-relevance' | 'hype' | 'minor-release'>;
export type ThresholdScores = Pick<Classification, 'relevance' | 'hype' | 'minorRelease'>;
export type ThresholdLimits = Pick<Thresholds, 'minRelevance' | 'maxHype' | 'maxMinorRelease'>;

interface ThresholdRule {
  readonly reason: ThresholdReason;
  readonly breaks: (scores: ThresholdScores, limits: ThresholdLimits) => boolean;
}

/**
 * The one definition of the score thresholds, in the order the contract applies them. A value
 * equal to its limit is kept. Limits come from config; no number lives here.
 */
const RULES: readonly ThresholdRule[] = [
  { reason: 'low-relevance', breaks: (s, l) => s.relevance < l.minRelevance },
  { reason: 'hype', breaks: (s, l) => s.hype > l.maxHype },
  { reason: 'minor-release', breaks: (s, l) => s.minorRelease > l.maxMinorRelease },
];

/** The threshold drop reasons, in contract order. */
export const THRESHOLD_REASONS: readonly ThresholdReason[] = RULES.map((rule) => rule.reason);

/** The first rule the scores break, or `undefined` when they pass all of them. */
export function failedThreshold(
  classification: ThresholdScores,
  thresholds: ThresholdLimits,
): ThresholdReason | undefined {
  return RULES.find((rule) => rule.breaks(classification, thresholds))?.reason;
}

/** True when an item's scores clear every threshold: relevant enough, not hype, not a minor release. */
export function passesThresholds(
  classification: ThresholdScores,
  thresholds: ThresholdLimits,
): boolean {
  return failedThreshold(classification, thresholds) === undefined;
}
