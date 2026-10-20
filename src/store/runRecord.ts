import { z } from 'zod';
import { DeliveryIdSchema } from '../delivery/deliveryId';
import { StepNameSchema, RunStatusSchema, WeekIdSchema } from '../domain/schemas';
import { GuardCheckIdSchema } from '../guards/guardVerdict';
import { JudgeScoreSchema } from '../select/judgeScore';

const DraftOutcomeSchema = z.object({
  writer: z.string().min(1),
  passed: z.boolean(),
  /** Check or guard ids that rejected the draft, e.g. "linkCheck", "graniteGroundedness". */
  rejectedBy: z.array(z.string()),
  score: JudgeScoreSchema.optional(),
});
export type DraftOutcome = z.infer<typeof DraftOutcomeSchema>;

/** What one run saved as `run.json`. A new field must be optional so old records still parse. */
export const RunRecordSchema = z.object({
  runId: WeekIdSchema,
  status: RunStatusSchema,
  dryRun: z.boolean(),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  profile: z.string().min(1),
  modelsByRole: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
  /** Seed and temperature per role the run's model calls used. Absent in older records. */
  sampling: z
    .object({
      seed: z.number().int().min(0),
      temperatureByRole: z.record(z.string(), z.number()),
    })
    .optional(),
  /** True when no writer draft survived and the digest was rendered from the items' own text (W11-02). */
  fallback: z.boolean().optional(),
  timings: z.array(z.object({ step: StepNameSchema, ms: z.number().min(0) })),
  counts: z.object({
    collected: z.number().int().min(0),
    afterGuardInput: z.number().int().min(0),
    classified: z.number().int().min(0),
    /** Items left after the process step. Absent in older records. */
    afterProcess: z.number().int().min(0).optional(),
    selected: z.number().int().min(0),
    /** Items the model input guards checked after process (PERF-2). Absent in older records. */
    guardedCandidates: z.number().int().min(0).optional(),
    digestItems: z.number().int().min(0),
  }),
  failedSources: z.array(z.object({ sourceId: z.string(), error: z.string() })),
  disabledGuards: z.array(GuardCheckIdSchema),
  drafts: z.array(DraftOutcomeSchema),
  winner: z.string().nullable(),
  /** URLs delivered in this run; feeds cross-week dedupe. */
  sentUrls: z.array(z.url()),
  /**
   * Channels that got this week's digest. Set on a partly delivered (failed) run, so a rerun
   * sends the saved digest.md to the other channels only. Absent in older records.
   */
  deliveredTo: z.array(DeliveryIdSchema).optional(),
  error: z.object({ message: z.string(), step: StepNameSchema.optional() }).optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
