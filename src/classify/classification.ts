import { z } from 'zod';
import { ItemSchema } from '../domain/schemas';

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

/** An item with its classification: what `process` and `write` read. */
export const ScoredItemSchema = ItemSchema.extend({ classification: ClassificationSchema });
export type ScoredItem = z.infer<typeof ScoredItemSchema>;
