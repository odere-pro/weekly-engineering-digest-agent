// How a week replay is saved as a checkpoint and read back (see checkpoint.ts).
import { z } from 'zod';
import { DraftSchema, ItemSchema } from '../src/domain/schemas';
import { GuardCheckIdSchema, GuardVerdictSchema } from '../src/guards/guardVerdict';
import { RunRecordSchema } from '../src/store/runRecord';
import type { CheckpointCodec } from './checkpoint';
import type { Replay } from './replay/replay';

const SavedReplaySchema = z.object({
  weekId: z.string(),
  items: z.array(ItemSchema),
  markdown: z.string().optional(),
  record: RunRecordSchema,
  durationMs: z.number().min(0),
  inputVerdicts: z.array(
    z.object({ guardId: GuardCheckIdSchema, itemId: z.string(), verdict: GuardVerdictSchema }),
  ),
  outputVerdicts: z.array(z.object({ draft: DraftSchema, verdict: GuardVerdictSchema })),
  served: z.array(z.string()),
});

export const replayCodec: CheckpointCodec<Replay> = {
  encode: (replay) => ({ ...replay, served: [...replay.served] }),
  decode: (saved) => {
    const parsed = SavedReplaySchema.safeParse(saved);
    if (!parsed.success) return undefined;
    const { served, ...rest } = parsed.data;
    return { ...rest, markdown: rest.markdown, served: new Set(served) };
  },
};
