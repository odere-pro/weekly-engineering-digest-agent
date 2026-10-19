import { buildReviewSheet } from '../../../render/reviewSheet';
import { errorMessage } from '../../../shared/errors';
import type { ArtifactName } from '../../../store/RunStore';
import type { RunRecord } from '../../../store/runRecord';
import type { EndingContext, HeldArtifact } from '../types';
import { DraftsFileSchema, ItemsFileSchema, ScoresFileSchema } from './runFiles';

/**
 * Best effort (W7-07): the sheet a reader ticks to say which picks were wrong and which
 * candidates were missed. Built without a model from the run's files, held or already written.
 * A run with no winner never reached the write step, so it gets none.
 */
export async function writeReviewSheet(
  ctx: EndingContext,
  record: RunRecord,
  held: readonly HeldArtifact[],
): Promise<void> {
  if (record.winner === null) return;
  let sheet: string;
  try {
    const read = async (name: ArtifactName): Promise<unknown> => {
      const content =
        held.findLast((artifact) => artifact.name === name)?.content ??
        (await ctx.deps.store.readArtifact(ctx.weekId, name));
      if (content === undefined) throw new Error(`${name} is missing`);
      return JSON.parse(content);
    };
    const items = ItemsFileSchema.parse(await read('items.json'));
    const classifications = ScoresFileSchema.parse(await read('scores.json'));
    const { drafts } = DraftsFileSchema.parse(await read('drafts.json'));
    const winner = drafts.find((draft) => draft.writer === record.winner);
    if (!winner) throw new Error(`no draft by the winner ${record.winner}`);
    const pickedIds = winner.digest.items.map((item) => item.itemId);
    sheet = buildReviewSheet({ weekId: ctx.weekId, items, classifications, pickedIds });
  } catch (error) {
    ctx.logger.warn('Could not build the review sheet', { error: errorMessage(error) });
    return;
  }
  try {
    await ctx.deps.store.saveArtifact(ctx.weekId, 'review.md', sheet);
  } catch (error) {
    ctx.logger.error('Could not write review.md', { error: errorMessage(error) });
  }
}
