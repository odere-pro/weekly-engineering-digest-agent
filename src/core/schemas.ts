// Domain schemas shared by every step, port and adapter. Frozen after Wave 0:
// change them only on main, then rebase open branches.
import { z } from 'zod';

/** Model roles. The code asks for a role; a profile maps each role to an Ollama tag. */
export const RoleSchema = z.enum(['classify', 'guardPolicy', 'guardRisk', 'write', 'judge']);
export type Role = z.infer<typeof RoleSchema>;

export const SourceKindSchema = z.enum(['rss', 'github']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** One allowlisted feed. For `github`, `url` is the repository URL (https://github.com/<owner>/<repo>). */
export const SourceSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  kind: SourceKindSchema,
  url: z.url(),
  /** Optional hint for the classifier, e.g. "ai-models". */
  area: z.string().min(1).optional(),
  /** Per-source cap; falls back to config.maxItemsPerSource. */
  maxItems: z.number().int().min(1).max(100).optional(),
});
export type Source = z.infer<typeof SourceSchema>;

/** A collected item. All text fields are untrusted web content. */
export const ItemSchema = z.object({
  /** Stable id: hash of the normalized URL. */
  id: z.string().min(1),
  sourceId: z.string().min(1),
  kind: SourceKindSchema,
  url: z.url(),
  title: z.string(),
  /** Plain text, HTML stripped, truncated by the fetcher. */
  summary: z.string(),
  publishedAt: z.iso.datetime({ offset: true }),
});
export type Item = z.infer<typeof ItemSchema>;

/** Classifier output for one item. Probabilities are 0..1. */
export const ClassificationSchema = z.object({
  itemId: z.string().min(1),
  /** Expected relevance on the 0-3 scale. */
  relevance: z.number().min(0).max(3),
  area: z.string().min(1),
  areaConfidence: z.number().min(0).max(1),
  /** Probability that the item is hype or marketing. */
  hype: z.number().min(0).max(1),
  /** Probability that the item is a minor version bump. */
  minorRelease: z.number().min(0).max(1),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const ScoredItemSchema = ItemSchema.extend({ classification: ClassificationSchema });
export type ScoredItem = z.infer<typeof ScoredItemSchema>;

export const GuardCheckIdSchema = z.enum([
  'clefPolicy',
  'graniteRisk',
  'graniteGroundedness',
  'clefRubric',
]);
export type GuardCheckId = z.infer<typeof GuardCheckIdSchema>;

export const GuardVerdictSchema = z.object({
  check: GuardCheckIdSchema,
  flagged: z.boolean(),
  /** Probability of the flag when the model gives one. */
  probability: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
});
export type GuardVerdict = z.infer<typeof GuardVerdictSchema>;

export const WEEK_ID_PATTERN = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
export const WeekIdSchema = z.string().regex(WEEK_ID_PATTERN, 'ISO week id like 2026-W43');

export const DigestItemSchema = z.object({
  itemId: z.string().min(1),
  title: z.string().min(1),
  url: z.url(),
  area: z.string().min(1),
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
});
export type DigestItem = z.infer<typeof DigestItemSchema>;

export const DigestSchema = z.object({
  weekId: WeekIdSchema,
  headline: z.string().min(1),
  intro: z.string().min(1),
  items: z.array(DigestItemSchema).min(1),
});
export type Digest = z.infer<typeof DigestSchema>;

/** One writer's draft. `writer` is the writer model tag, used as an opaque id by the core. */
export const DraftSchema = z.object({
  writer: z.string().min(1),
  digest: DigestSchema,
});
export type Draft = z.infer<typeof DraftSchema>;

export const JudgeScoreSchema = z.object({
  writer: z.string().min(1),
  /** Overall 1-5. */
  score: z.number().min(1).max(5),
  byCriterion: z.record(z.string(), z.number()),
});
export type JudgeScore = z.infer<typeof JudgeScoreSchema>;

export const DraftOutcomeSchema = z.object({
  writer: z.string().min(1),
  passed: z.boolean(),
  /** Check or guard ids that rejected the draft, e.g. "linkCheck", "graniteGroundedness". */
  rejectedBy: z.array(z.string()),
  score: JudgeScoreSchema.optional(),
});
export type DraftOutcome = z.infer<typeof DraftOutcomeSchema>;

export const StepNameSchema = z.enum([
  'collect',
  'guardInput',
  'classify',
  'process',
  'write',
  'guardOutput',
  'select',
  'deliver',
]);
export type StepName = z.infer<typeof StepNameSchema>;

/**
 * sent: delivered. dry-run: written to disk only. skipped: the week already has a sent digest.
 * quiet: nothing worth sending. blocked: every draft was rejected by guards or checks. failed: error.
 */
export const RunStatusSchema = z.enum(['sent', 'dry-run', 'skipped', 'quiet', 'blocked', 'failed']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ExitCode = { Sent: 0, Failed: 1, Blocked: 2, Quiet: 3 } as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export function exitCodeFor(status: RunStatus): ExitCode {
  switch (status) {
    case 'sent':
    case 'dry-run':
    case 'skipped':
      return ExitCode.Sent;
    case 'quiet':
      return ExitCode.Quiet;
    case 'blocked':
      return ExitCode.Blocked;
    case 'failed':
      return ExitCode.Failed;
  }
}

export const RunRecordSchema = z.object({
  runId: WeekIdSchema,
  status: RunStatusSchema,
  dryRun: z.boolean(),
  startedAt: z.iso.datetime({ offset: true }),
  finishedAt: z.iso.datetime({ offset: true }),
  profile: z.string().min(1),
  modelsByRole: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
  timings: z.array(z.object({ step: StepNameSchema, ms: z.number().min(0) })),
  counts: z.object({
    collected: z.number().int().min(0),
    afterGuardInput: z.number().int().min(0),
    classified: z.number().int().min(0),
    selected: z.number().int().min(0),
    digestItems: z.number().int().min(0),
  }),
  failedSources: z.array(z.object({ sourceId: z.string(), error: z.string() })),
  disabledGuards: z.array(GuardCheckIdSchema),
  drafts: z.array(DraftOutcomeSchema),
  winner: z.string().nullable(),
  /** URLs delivered in this run; feeds cross-week dedupe. */
  sentUrls: z.array(z.url()),
  error: z.object({ message: z.string(), step: StepNameSchema.optional() }).optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
