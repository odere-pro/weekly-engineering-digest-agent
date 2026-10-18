import { z } from 'zod';

export const JudgeScoreSchema = z.object({
  writer: z.string().min(1),
  /** Overall 1-5. */
  score: z.number().min(1).max(5),
  byCriterion: z.record(z.string(), z.number()),
});
export type JudgeScore = z.infer<typeof JudgeScoreSchema>;
