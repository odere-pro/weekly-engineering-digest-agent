// Domain schemas shared by several features. Frozen: change them only on main, then rebase open
// branches. A type that one feature owns lives in that feature (see CLAUDE.md for where).
import { z } from 'zod';

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

export const WEEK_ID_PATTERN = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
export const WeekIdSchema = z.string().regex(WEEK_ID_PATTERN, 'ISO week id like 2026-W43');

/** How soon a reader should act on an item (W8): the digest groups its items by it. */
export const UrgencySchema = z.enum(['act-now', 'worth-a-look', 'good-to-know']);
export type Urgency = z.infer<typeof UrgencySchema>;

export const DigestItemSchema = z.object({
  itemId: z.string().min(1),
  title: z.string().min(1),
  url: z.url(),
  area: z.string().min(1),
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  /** Absent in drafts written before W8; read as 'worth-a-look'. */
  urgency: UrgencySchema.optional(),
  /** One short line: what to do (act-now) or who it is for (worth-a-look). */
  action: z.string().max(200).optional(),
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

export const StepNameSchema = z.enum([
  'collect',
  'guardInput',
  'classify',
  'process',
  'guardCandidates',
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
