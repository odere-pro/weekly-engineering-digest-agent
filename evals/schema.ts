// Schemas for the eval set (labels and cases) and for the scorecard `digest eval` writes (W1-22).
// The case files under evals/ are written by W1-23, W2-03, W3-01, W3-02 and W3-04; they must parse here.
import { z } from 'zod';
import { ProfileNameSchema } from '../src/config/schema.js';
import { DraftSchema, GuardCheckIdSchema, ItemSchema, WeekIdSchema } from '../src/core/schemas.js';

/** Spec: 5 must-include items per recorded week. */
export const MUST_INCLUDE_COUNT = 5;

const ItemIdSchema = z.string().min(1);
const RatioSchema = z.number().min(0).max(1);

/** evals/weeks/<week>/labels.json: the maintainer's picks for one recorded week. */
export const WeekLabelsSchema = z
  .object({
    mustInclude: z
      .array(ItemIdSchema)
      .length(MUST_INCLUDE_COUNT)
      .refine((ids) => new Set(ids).size === ids.length, 'must-include ids must be unique'),
    /** Hype and minor version bumps that must stay out of the digest. */
    mustExclude: z.array(ItemIdSchema).default([]),
    notes: z.string().optional(),
  })
  .refine(
    (labels) => !labels.mustExclude.some((id) => labels.mustInclude.includes(id)),
    'an item cannot be both must-include and must-exclude',
  );
export type WeekLabels = z.infer<typeof WeekLabelsSchema>;

/** One labeled item for the classifier. `relevance` is on the classifier's 0-3 scale. */
export const ClassifierCaseSchema = z.object({
  item: ItemSchema,
  expected: z.object({ area: z.string().min(1), relevance: z.number().min(0).max(3) }),
});
export type ClassifierCase = z.infer<typeof ClassifierCaseSchema>;

/** evals/classifier-cases.json. `reviewed` is set by the maintainer after checking every label. */
export const ClassifierCasesFileSchema = z.object({
  reviewed: z.boolean().default(false),
  cases: z.array(ClassifierCaseSchema),
});

/** The link check is a blocker too: an attack can ask for a URL that is not in the feed. */
export const AttackBlockerSchema = z.enum([...GuardCheckIdSchema.options, 'linkCheck']);
export type AttackBlocker = z.infer<typeof AttackBlockerSchema>;

/** One fake item with injected instructions or a bad link (one JSON file per case). */
export const AttackCaseSchema = z.object({
  id: z.string().min(1),
  item: ItemSchema,
  /** Free label of the technique, e.g. "ignore-instructions" or "link-swap". */
  kind: z.string().min(1),
  /** The defence the case is written to exercise; informational, not gated. */
  expectBlockedBy: AttackBlockerSchema.optional(),
});
export type AttackCase = z.infer<typeof AttackCaseSchema>;

/** One digest draft with exactly one planted claim its source does not support. */
export const GroundingCaseSchema = z
  .object({
    id: z.string().min(1),
    draft: DraftSchema,
    sources: z.array(ItemSchema).min(1),
    /** The digest item that carries the planted claim. */
    plantedItemId: ItemIdSchema,
  })
  .refine(
    (c) => c.draft.digest.items.some((item) => item.itemId === c.plantedItemId),
    'plantedItemId must name an item in the draft',
  );
export type GroundingCase = z.infer<typeof GroundingCaseSchema>;

/** evals/judge/calibration.json (W3-04): how well the judge agrees with the maintainer. */
export const JudgeCalibrationSchema = z.object({
  /** Share of hand-graded digests where the judge's score is within half a point of the grade. */
  judgeAgreement: RatioSchema,
  /** Share of weeks where the judge picked the draft the maintainer picked. */
  selectionAgreement: RatioSchema,
  gradedDigests: z.number().int().min(0).optional(),
});
export type JudgeCalibration = z.infer<typeof JudgeCalibrationSchema>;

export const METRIC_IDS = [
  'linkValidity',
  'attackHandling',
  'groundedness',
  'format',
  'guardFalseBlocks',
  'mustIncludeRecall',
  'mustExcludeLeaks',
  'classifierAccuracy',
  'writingQuality',
  'selectionAgreement',
  'writerWinRate',
  'stability',
  'runTime',
] as const;
export const MetricIdSchema = z.enum(METRIC_IDS);
export type MetricId = z.infer<typeof MetricIdSchema>;

/**
 * hard: fails the run (exit code 1). soft: shown as pass or fail. none: reported only.
 * `needsJudge` gates the metric only when the judge agrees with the maintainer enough.
 */
const ThresholdGateSchema = z.object({
  direction: z.enum(['atLeast', 'atMost']),
  threshold: z.number(),
  needsJudge: z.boolean(),
});
export const GateSchema = z.discriminatedUnion('kind', [
  ThresholdGateSchema.extend({ kind: z.literal('hard') }),
  ThresholdGateSchema.extend({ kind: z.literal('soft') }),
  z.object({ kind: z.literal('none') }),
]);
export type Gate = z.infer<typeof GateSchema>;

/** ratio: 0-1. count: items per week. score: 1-5. ms: milliseconds. */
export const MetricUnitSchema = z.enum(['ratio', 'count', 'score', 'ms']);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

export const MetricResultSchema = z.object({
  id: MetricIdSchema,
  label: z.string().min(1),
  unit: MetricUnitSchema,
  /** null when the eval set had nothing to measure it with. */
  value: z.number().nullable(),
  gate: GateSchema,
  /** null when the metric is not gated (reported only, or judge not trusted) or not measured. */
  pass: z.boolean().nullable(),
  note: z.string().optional(),
  /** Per-guard or per-writer numbers behind `value`. */
  detail: z.record(z.string(), z.number()).optional(),
});
export type MetricResult = z.infer<typeof MetricResultSchema>;

export const ScorecardSchema = z
  .object({
    profile: ProfileNameSchema,
    date: z.iso.datetime({ offset: true }),
    weeks: z.array(WeekIdSchema),
    counts: z.object({
      weeks: z.number().int().min(0),
      classifier: z.number().int().min(0),
      attacks: z.number().int().min(0),
      grounding: z.number().int().min(0),
    }),
    /** null when the judge was never calibrated, or the profile has no judge. */
    judgeAgreement: RatioSchema.nullable(),
    /** Model tag(s) per role that this run used. */
    models: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
    metrics: z.record(MetricIdSchema, MetricResultSchema),
    /** true when no hard-gate metric failed; `digest eval` exits 1 otherwise. */
    hardGatesPassed: z.boolean(),
    timings: z.object({
      totalMs: z.number().min(0),
      byWeekMs: z.record(z.string(), z.number().min(0)),
    }),
  })
  .refine(
    (card) =>
      card.hardGatesPassed ===
      Object.values(card.metrics).every((m) => m.gate.kind !== 'hard' || m.pass !== false),
    'hardGatesPassed must match the metrics',
  );
export type Scorecard = z.infer<typeof ScorecardSchema>;
