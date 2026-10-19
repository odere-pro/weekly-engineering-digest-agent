// Schemas for the eval set (labels and cases) and for the scorecard `digest eval` writes.
// Every case file under evals/ must parse here. A new metric needs the steps in metrics/CLAUDE.md.
import { z } from 'zod';
import { ProfileNameSchema } from '../src/config/schema';
import { DraftSchema, ItemSchema, WeekIdSchema, type Draft } from '../src/domain/schemas';
import { GuardCheckIdSchema } from '../src/guards/guardVerdict';

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
  /** Held out: never used to pick a threshold or tune a guard prompt. `attacks/README.md` lists them. */
  heldOut: z.boolean().optional(),
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
    /** Held out: never used to pick a threshold or tune a guard prompt. `grounding/README.md` lists them. */
    heldOut: z.boolean().optional(),
  })
  .refine(
    (c) => c.draft.digest.items.some((item) => item.itemId === c.plantedItemId),
    'plantedItemId must name an item in the draft',
  );
export type GroundingCase = z.infer<typeof GroundingCaseSchema>;

/**
 * The draft without one of its items: every claim left is supported, so it is a clean control.
 * undefined when that was the only item. Returns a new draft; the original is not touched.
 */
export function withoutItem(draft: Draft, itemId: string): Draft | undefined {
  const items = draft.digest.items.filter((item) => item.itemId !== itemId);
  return items.length === 0 ? undefined : { ...draft, digest: { ...draft.digest, items } };
}

/** evals/sources/<id>/response.json: what the recorder got from one source. */
export const SourceResponseSchema = z.object({
  /** The URL the fetcher requests: for a GitHub source its `releases.atom`. */
  url: z.url(),
  /** Absent when the request never got an answer. */
  status: z.number().int().optional(),
  contentType: z.string().nullable().optional(),
  fetchedAt: z.iso.datetime({ offset: true }),
  /** Absent when the recording failed; `error` then says why. */
  bodyFile: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});
export type SourceResponse = z.infer<typeof SourceResponseSchema>;

/** Fields of an item a fetcher is known to get wrong; the conformance test skips them. */
export const SourceGapSchema = z.enum(['summary']);
export type SourceGap = z.infer<typeof SourceGapSchema>;

/** evals/sources/<id>/expected.json: the items the recorded body must yield. */
export const SourceExpectedSchema = z.object({
  /** Set by the maintainer once the items were checked against the body by hand. */
  reviewed: z.boolean(),
  /** How many `<item>` or `<entry>` elements the body holds. */
  entryCount: z.number().int().min(0),
  items: z.array(ItemSchema),
  knownGaps: z.array(SourceGapSchema).default([]),
});
export type SourceExpected = z.infer<typeof SourceExpectedSchema>;

/** evals/judge/calibration.json (W3-04): how well the judge agrees with the maintainer. */
export const JudgeCalibrationSchema = z.object({
  /** Share of hand-graded digests where the judge's score is within half a point of the grade. */
  judgeAgreement: RatioSchema,
  /** Share of weeks where the judge picked the draft the maintainer picked. */
  selectionAgreement: RatioSchema,
  gradedDigests: z.number().int().min(0).optional(),
  /** Rank correlation of the hand grades and the judge scores; null when it is undefined. */
  spearman: z.number().min(-1).max(1).nullable().optional(),
  /** Mean distance between a hand grade and the judge's score, in points of the 1-5 scale. */
  meanAbsoluteDifference: z.number().min(0).optional(),
  /** Model tag of the judge that was calibrated. */
  judge: z.string().min(1).optional(),
});
export type JudgeCalibration = z.infer<typeof JudgeCalibrationSchema>;

export const METRIC_IDS = [
  'linkValidity',
  'attackHandling',
  'guardAttackRecall',
  'groundedness',
  'format',
  'factCarry',
  'guardFalseBlocks',
  'guardRealBlocks',
  'mustIncludeRecall',
  'mustExcludeLeaks',
  'classifierAccuracy',
  'writingQuality',
  'selectionAgreement',
  'writerWinRate',
  'stability',
  'runTime',
  'sourceParse',
  'sourceSummaryFill',
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

/**
 * One week behind a format or link measurement. no-digest: the run produced nothing to check.
 * `problems` holds the first few messages; `problemCount` is how many there were.
 */
export const WeekDetailSchema = z.object({
  status: z.enum(['ok', 'failed', 'no-digest']),
  problems: z.array(z.string()),
  problemCount: z.number().int().min(0),
});
export type WeekDetail = z.infer<typeof WeekDetailSchema>;

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
  /** Format and link validity: how each replayed week fared and why. */
  byWeek: z.record(z.string(), WeekDetailSchema).optional(),
  /** Stability: the digest item ids of each run of the repeated week, the first run included. */
  itemIdsByRun: z.array(z.array(z.string())).optional(),
});
export type MetricResult = z.infer<typeof MetricResultSchema>;

/**
 * Metrics added after the v0.1.0 baseline was written. A scorecard recorded before them has no
 * entry; reading it fills one in as "not recorded", so every scorecard has every metric.
 */
export const LATER_METRICS = {
  guardAttackRecall: { label: 'Guard attack recall', unit: 'ratio' },
  guardRealBlocks: { label: 'Guard blocks on real weeks', unit: 'ratio' },
  sourceParse: { label: 'Source parse yield', unit: 'ratio' },
  sourceSummaryFill: { label: 'Source summary fill', unit: 'ratio' },
  factCarry: { label: 'Fact carry', unit: 'ratio' },
} as const satisfies Partial<Record<MetricId, { label: string; unit: MetricUnit }>>;
const NOT_RECORDED = 'not recorded in this scorecard';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Adds a "not recorded" entry for each later metric a scorecard written earlier lacks. */
function withLaterMetrics(metrics: unknown): unknown {
  if (!isRecord(metrics)) return metrics;
  const missing = Object.entries(LATER_METRICS).filter(([id]) => !(id in metrics));
  const filled = missing.map(([id, meta]) => [
    id,
    { id, ...meta, value: null, gate: { kind: 'none' }, pass: null, note: NOT_RECORDED },
  ]);
  return { ...metrics, ...Object.fromEntries(filled) };
}

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
      /** Recorded sources checked; a scorecard written before wave 6 does not carry it. */
      sources: z.number().int().min(0).optional(),
    }),
    /** null when the judge was never calibrated, or the profile has no judge. */
    judgeAgreement: RatioSchema.nullable(),
    /** Model tag(s) per role that this run used. */
    models: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
    metrics: z.preprocess(withLaterMetrics, z.record(MetricIdSchema, MetricResultSchema)),
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
