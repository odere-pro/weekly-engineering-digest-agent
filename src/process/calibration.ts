import { z } from 'zod';
import { ProfileNameSchema } from '../config/schema';
import type { Classification } from '../classify/classification';

const MIN_RELEVANCE = 0;
const MAX_RELEVANCE = 3;

const PointSchema = z.object({
  raw: z.number().min(MIN_RELEVANCE).max(MAX_RELEVANCE),
  calibrated: z.number().min(MIN_RELEVANCE).max(MAX_RELEVANCE),
});

/**
 * A monotone map from the decider's raw relevance to a calibrated relevance on the same 0-3
 * scale, plus a bias added per area (keys are lowercase, trimmed area names). Fitted offline by
 * `evals/calibrate.ts`; the process step only applies it.
 */
export const CalibrationSchema = z
  .object({
    version: z.literal(1),
    profile: ProfileNameSchema,
    /** Piecewise-linear knots: `raw` strictly rising, `calibrated` never falling. */
    points: z.array(PointSchema).min(1),
    areaBias: z.record(z.string(), z.number()),
  })
  .refine(
    ({ points }) =>
      points.every((p, i) => {
        const before = points[i - 1];
        return before === undefined || (p.raw > before.raw && p.calibrated >= before.calibrated);
      }),
    { message: 'points must rise in raw and never fall in calibrated' },
  );
export type Calibration = z.infer<typeof CalibrationSchema>;

export const areaKey = (area: string): string => area.trim().toLowerCase();

const clamp = (value: number): number => Math.min(MAX_RELEVANCE, Math.max(MIN_RELEVANCE, value));

function interpolate(points: Calibration['points'], raw: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return raw;
  if (raw <= first.raw) return first.calibrated;
  if (raw >= last.raw) return last.calibrated;
  const upperIndex = points.findIndex((p) => p.raw >= raw);
  const upper = points[upperIndex];
  const lower = points[upperIndex - 1];
  if (upper === undefined || lower === undefined) return raw;
  const share = (raw - lower.raw) / (upper.raw - lower.raw);
  return lower.calibrated + share * (upper.calibrated - lower.calibrated);
}

/** The classification with its relevance replaced by the calibrated score. */
export function calibrateClassification(
  calibration: Calibration,
  classification: Classification,
): Classification {
  const bias = calibration.areaBias[areaKey(classification.area)] ?? 0;
  return {
    ...classification,
    relevance: clamp(interpolate(calibration.points, classification.relevance) + bias),
  };
}
