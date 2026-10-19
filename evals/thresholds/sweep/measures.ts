// The numbers the sweeps and the result share: the float tolerance, the ratio helper and the two
// spec gates the proposed thresholds are judged by.
import { DigestError } from '../../../src/shared/errors';
import { GATES } from '../../metrics';
import type { Gate } from '../../schema';

/** Absorbs floating-point noise when comparing scores and thresholds. */
export const EPSILON = 1e-9;

/** `count` out of `total`; null without cases, never NaN. */
export const share = (count: number, total: number): number | null =>
  total === 0 ? null : count / total;

/** The threshold of a gated metric; a metric without a gate is a mistake in the caller. */
export function gateThreshold(gate: Gate): number {
  if (gate.kind === 'none') throw new DigestError('expected a gated metric');
  return gate.threshold;
}

/** The spec's per-guard false-block budget (GATES.guardFalseBlocks). */
export const MAX_FALSE_BLOCK_RATE = gateThreshold(GATES.guardFalseBlocks);
/** The spec's classifier accuracy gate (GATES.classifierAccuracy). */
export const MIN_CLASSIFIER_ACCURACY = gateThreshold(GATES.classifierAccuracy);
