import {
  areaKey,
  calibrateClassification,
  type Calibration,
} from '../../../src/process/calibration';
import type { Sample } from './types';

/** An area with n samples keeps n / (n + this) of its mean error as bias. */
const BIAS_SHRINK = 5;
/** No area is moved by more than this. */
const MAX_BIAS = 0.5;

export type Points = Calibration['points'];

/** The relevance the isotonic points give a raw score, before any area bias. */
export function evaluate(points: Points, raw: number): number {
  const probe: Calibration = { version: 1, profile: 'light', points, areaBias: {} };
  return calibrateClassification(probe, {
    itemId: '',
    relevance: raw,
    area: 'x',
    areaConfidence: 0,
    hype: 0,
    minorRelease: 0,
  }).relevance;
}

/** Per area: the mean error left after the points, shrunk toward 0 and capped at `MAX_BIAS`. */
export function fitAreaBias(samples: readonly Sample[], points: Points): Record<string, number> {
  const byArea = new Map<string, number[]>();
  for (const sample of samples) {
    const key = areaKey(sample.area);
    byArea.set(key, [...(byArea.get(key) ?? []), sample.target - evaluate(points, sample.raw)]);
  }
  return Object.fromEntries(
    [...byArea.entries()].map(([key, errors]) => {
      const mean = errors.reduce((sum, e) => sum + e, 0) / errors.length;
      const shrunk = (mean * errors.length) / (errors.length + BIAS_SHRINK);
      return [key, Math.max(-MAX_BIAS, Math.min(MAX_BIAS, shrunk))];
    }),
  );
}
