import { z } from 'zod';
import { ClassificationSchema } from '../../../classify/classification';
import { DraftSchema, ItemSchema } from '../../../domain/schemas';

/** Every run file is pretty JSON with a trailing newline. */
export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const ItemsFileSchema = z.array(ItemSchema);
export const ScoresFileSchema = z.array(ClassificationSchema);
/** The part of drafts.json that rebuilds a digest: every draft the writers made. */
export const DraftsFileSchema = z.object({ drafts: z.array(DraftSchema) });
