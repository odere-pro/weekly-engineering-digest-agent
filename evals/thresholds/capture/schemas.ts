// Raw model outputs for threshold tuning (W3-03): the schema of evals/thresholds/raw/*.json,
// and the small readers over it. captureRaw.ts fills it.
import { z } from 'zod';
import { ProfileNameSchema, ThresholdsSchema } from '../../../src/config/schema';
import { WeekIdSchema } from '../../../src/domain/schemas';

const Probability = z.number().min(0).max(1);
const Relevance = z.number().min(0).max(3);
const FailedSchema = z.object({ error: z.string().min(1) });
export type Failed = z.infer<typeof FailedSchema>;

const ClassifiedSchema = z.object({
  relevance: Relevance,
  area: z.string().min(1),
  areaConfidence: Probability,
  hype: Probability,
  minorRelease: Probability,
});
export type Classified = z.infer<typeof ClassifiedSchema>;
const ClassifyResultSchema = z.union([ClassifiedSchema, FailedSchema]);
const ProbabilityResultSchema = z.union([z.object({ probability: Probability }), FailedSchema]);

const ClassifierRecordSchema = z.object({
  itemId: z.string().min(1),
  expected: z.object({ area: z.string().min(1), relevance: Relevance }),
  result: ClassifyResultSchema,
});
export type ClassifierRecord = z.infer<typeof ClassifierRecordSchema>;

const WeekItemRecordSchema = z.object({
  itemId: z.string().min(1),
  weekId: WeekIdSchema,
  label: z.enum(['mustInclude', 'mustExclude']).nullable(),
  result: ClassifyResultSchema,
});
export type WeekItemRecord = z.infer<typeof WeekItemRecordSchema>;

const InputGuardRecordSchema = z.object({
  itemId: z.string().min(1),
  title: z.string(),
  /** clean: an item of a recorded week. attack: an attack case. */
  kind: z.enum(['clean', 'attack']),
  /** The week id or the attack case id. */
  from: z.string().min(1),
  /** The highest P(yes) over the guard's questions; it flags above guardFlag. */
  clefPolicy: ProbabilityResultSchema,
  graniteRisk: z.union([
    z.object({ flagged: z.boolean(), reason: z.string().optional() }),
    FailedSchema,
  ]),
});
export type InputGuardRecord = z.infer<typeof InputGuardRecordSchema>;

const OutputGuardRecordSchema = z.object({
  caseId: z.string().min(1),
  /** planted: the grounding case's draft. control: that draft without the planted item. */
  draft: z.enum(['planted', 'control']),
  clefRubric: ProbabilityResultSchema,
});
export type OutputGuardRecord = z.infer<typeof OutputGuardRecordSchema>;

export const RawCaptureSchema = z.object({
  profile: ProfileNameSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  ollamaVersion: z.string().nullable(),
  models: z.object({ classify: z.string(), guardPolicy: z.string(), guardRisk: z.string() }),
  focusAreas: z.array(z.string()),
  /** The thresholds in config when the outputs were captured; the sweep starts from them. */
  baseline: ThresholdsSchema,
  classifier: z.array(ClassifierRecordSchema),
  weekItems: z.array(WeekItemRecordSchema),
  inputGuards: z.array(InputGuardRecordSchema),
  outputGuards: z.array(OutputGuardRecordSchema),
  timingsMs: z.record(z.string(), z.number().min(0)),
});
export type RawCapture = z.infer<typeof RawCaptureSchema>;

/** What a capture run produces: the records and the time each phase took. */
export type CaptureData = Pick<
  RawCapture,
  'classifier' | 'weekItems' | 'inputGuards' | 'outputGuards' | 'timingsMs'
>;

/** A call that threw: its message instead of an answer. */
export function isFailed(result: object): result is Failed {
  return 'error' in result;
}

/** Every failed call in a capture, by phase. */
export function failedCalls(raw: Omit<CaptureData, 'timingsMs'>): Record<string, number> {
  const count = <T>(records: readonly T[], result: (record: T) => object): number =>
    records.filter((record) => 'error' in result(record)).length;
  return {
    classifier: count(raw.classifier, (r) => r.result),
    weekItems: count(raw.weekItems, (r) => r.result),
    clefPolicy: count(raw.inputGuards, (r) => r.clefPolicy),
    graniteRisk: count(raw.inputGuards, (r) => r.graniteRisk),
    clefRubric: count(raw.outputGuards, (r) => r.clefRubric),
  };
}

/** All failed calls in a capture, over every phase. */
export function totalFailed(raw: Omit<CaptureData, 'timingsMs'>): number {
  return Object.values(failedCalls(raw)).reduce((sum, n) => sum + n, 0);
}
