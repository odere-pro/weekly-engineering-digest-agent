import type { ProfileName } from '../../../src/config/schema';
import type { Calibration } from '../../../src/process/calibration';
import { DigestError } from '../../../src/shared/errors';
import { fitAreaBias } from './areaBias';
import { blockValue, groupByRaw, pool } from './blocks';
import type { Sample } from './types';

/** Isotonic fit of target on raw score (knots at block means) plus a shrunk per-area bias. */
export function fitCalibration(samples: readonly Sample[], profile: ProfileName): Calibration {
  if (samples.length === 0) throw new DigestError('calibration: no samples to fit');
  const points = pool(groupByRaw(samples)).map(blockValue);
  return { version: 1, profile, points, areaBias: fitAreaBias(samples, points) };
}
