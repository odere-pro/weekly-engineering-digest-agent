import { z } from 'zod';
import { DigestItemSchema, DigestSchema, UrgencySchema } from '../domain/schemas';

/**
 * The step replaces every item url with the source url, so a missing or malformed url from the
 * model is not worth a repair call.
 *
 * The writer must say how urgent each item is and what to do about it (W8-01), so urgency and
 * action are required here, while `DigestSchema` keeps them optional for drafts written before
 * W8. The action is a string that is empty for good-to-know. Its length is the format check's
 * business (a retry can fix it), so no maximum here; `prepareDraft` bounds it before it is stored.
 */
export const WrittenItemSchema = DigestItemSchema.extend({
  url: z.string().nullish(),
  urgency: UrgencySchema,
  action: z.string(),
});
export type WrittenItem = z.infer<typeof WrittenItemSchema>;

/** The model writes everything but the week; the step sets it. */
export const DigestBodySchema = DigestSchema.omit({ weekId: true }).extend({
  items: z.array(WrittenItemSchema).min(1),
});
