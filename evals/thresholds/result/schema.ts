// The tuning result file (evals/thresholds/<date>-<profile>.json): what `sweep` makes of one raw
// capture.
import { z } from 'zod';
import { ProfileNameSchema, ThresholdsSchema } from '../../../src/config/schema';
import { RawCaptureSchema } from '../capture/schemas';

const Count = z.number().int().min(0);
const Ratio = z.number().min(0).max(1).nullable();
const FilterOutcomeSchema = z.object({
  accuracy: Ratio,
  kept: Count,
  dropped: Count,
  wronglyKept: Count,
  wronglyDropped: Count,
});
const CurveSchema = z.array(z.object({ value: z.number(), accuracy: Ratio }));
const WeekCheckSchema = z.object({
  items: Count,
  kept: Count,
  mustInclude: Count,
  mustIncludeKept: Count,
  mustExclude: Count,
  mustExcludeDropped: Count,
});
export type WeekCheck = z.infer<typeof WeekCheckSchema>;
const GuardFlagPointSchema = z.object({
  value: z.number(),
  policyFalseBlockRate: Ratio,
  attacksCaught: Count,
  rubricFalseBlockRate: Ratio,
  plantedFlagged: Count,
  anyFalseBlockRate: Ratio,
  anyAttacksCaught: Count,
});
const BlockedSchema = z.object({ itemId: z.string(), title: z.string(), from: z.string() });
const MinGateSchema = z.object({ value: Ratio, min: z.number(), pass: z.boolean() });
const MaxGateSchema = z.object({ value: Ratio, max: z.number(), pass: z.boolean() });

const SideSizeSchema = z.object({
  weeks: z.array(z.string()),
  classifierCases: Count,
  cleanItems: Count,
  attacks: Count,
  drafts: Count,
});
const SideScoreSchema = z.object({
  classifierAccuracy: Ratio,
  filterAccuracy: Ratio,
  falseBlocks: Ratio,
  attackRecall: Ratio,
});
const GapSchema = z.number().min(-1).max(1).nullable();

/** evals/thresholds/<date>-<profile>.json: what `sweep` makes of one raw capture. */
export const TuningResultSchema = z.object({
  profile: ProfileNameSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  ollamaVersion: z.string().nullable(),
  models: RawCaptureSchema.shape.models,
  method: z.record(z.string(), z.string()),
  baseline: ThresholdsSchema,
  proposed: ThresholdsSchema,
  classifier: z.object({
    cases: Count,
    failed: Count,
    /** The scorecard's classifier accuracy (area and relevance within 0.5); no threshold changes it. */
    scorecard: z.object({ value: Ratio, area: Ratio, relevance: Ratio }),
    filter: z.object({ baseline: FilterOutcomeSchema, proposed: FilterOutcomeSchema }),
    curves: z.object({
      minRelevance: CurveSchema,
      maxHype: CurveSchema,
      maxMinorRelease: CurveSchema,
    }),
  }),
  /** The filter on every recorded week item, against the maintainer's week labels. */
  weeks: z.object({ failed: Count, baseline: WeekCheckSchema, proposed: WeekCheckSchema }),
  guards: z.object({
    clean: Count,
    attacks: Count,
    controls: Count,
    planted: Count,
    failed: z.object({ clefPolicy: Count, graniteRisk: Count, clefRubric: Count }),
    baseline: GuardFlagPointSchema,
    proposed: GuardFlagPointSchema,
    clefPolicyFalseBlocks: z.array(BlockedSchema),
    graniteRisk: z.object({
      clean: Count,
      attacks: Count,
      falseBlockRate: Ratio,
      attacksCaught: Count,
      falseBlocks: z.array(BlockedSchema),
    }),
    curve: z.array(GuardFlagPointSchema),
  }),
  acceptance: z.object({
    /** The spec's classifier gate, on the scorecard's measure. */
    classifierAccuracy: MinGateSchema,
    /** Keep or drop as labelled, at the proposed thresholds. */
    filterAccuracy: MinGateSchema,
    /** The spec's per-guard gate: the worst input or output guard at the proposed guardFlag. */
    guardFalseBlocks: MaxGateSchema,
    /** Mode "any", the default: clean week items that either input guard flags. */
    inputFalseBlocksAnyMode: MaxGateSchema,
    /** Every model call answered; in a real run a failed call fails the run. */
    failedCalls: z.object({ count: Count, pass: z.boolean() }),
  }),
  timingsMs: z.record(z.string(), z.number().min(0)),
  /**
   * Thresholds are picked on `train` and scored on both sides. Every section above describes the
   * train side. Results from before W6-04 have neither field and picked on all the data.
   */
  split: z.object({ train: SideSizeSchema, holdout: SideSizeSchema, caseStride: Count }).optional(),
  scores: z
    .object({
      train: SideScoreSchema,
      holdout: SideScoreSchema,
      gap: z.object({
        classifierAccuracy: GapSchema,
        filterAccuracy: GapSchema,
        falseBlocks: GapSchema,
      }),
      warnings: z.array(z.string()),
    })
    .optional(),
});
export type TuningResult = z.infer<typeof TuningResultSchema>;
