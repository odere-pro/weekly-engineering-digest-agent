import { z } from 'zod';

export const GuardCheckIdSchema = z.enum([
  /** Deterministic injection patterns, no model call; runs first (W11-04). */
  'ruleInjection',
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
