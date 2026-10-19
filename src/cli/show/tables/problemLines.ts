import { z } from 'zod';
import { truncate } from '../../../shared/text';

export const MAX_PROBLEM_CHARS = 200;

/** What `drafts.json` says about the writers that did not deliver a draft; both lists are optional. */
export const OutcomeNotesSchema = z.object({
  failures: z
    .array(z.object({ writer: z.string(), error: z.string().optional() }))
    .optional()
    .catch(undefined),
  rejections: z
    .array(
      z.object({
        writer: z.string(),
        attempt: z.number().optional(),
        rejectedBy: z.array(z.string()),
        problems: z.array(z.string()),
      }),
    )
    .optional()
    .catch(undefined),
});
export type OutcomeNotes = z.infer<typeof OutcomeNotesSchema>;

/** The "Problems:" block under the drafts table; empty when no writer was rejected or failed. */
export function problemLines(notes: OutcomeNotes): string {
  const lines = [
    ...(notes.rejections ?? []).flatMap((rejection) =>
      rejection.problems.map(
        (problem) => `  ${rejection.writer}: ${truncate(problem, MAX_PROBLEM_CHARS)}`,
      ),
    ),
    ...(notes.failures ?? []).map(
      (failure) => `  ${failure.writer}: ${truncate(failure.error ?? 'failed', MAX_PROBLEM_CHARS)}`,
    ),
  ];
  return lines.length === 0 ? '' : `\nProblems:\n${lines.join('\n')}\n`;
}
