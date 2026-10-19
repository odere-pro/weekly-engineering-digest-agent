import { errorMessage } from '../../shared/errors';
import type { ArtifactName } from '../../store/RunStore';
import type { RunRecord } from '../../store/runRecord';
import { keepReason } from './keepReason';
import { sendOrHoldNote } from './notes/failureNotes';
import { saveErrorFile } from './runFiles/errorFile';
import { writeHeld } from './runFiles/heldArtifacts';
import { writeReviewSheet } from './runFiles/reviewSheet';
import { saveRecord } from './saveRecord';
import type { Ended, Ending, EndingContext } from './types';

/**
 * Ends a run (W2-08): the record, the held artifacts, error.json, the failure note, pruning.
 * `previous` is the week's record before this run; it may stay (see `keepReason`), and then the
 * held artifacts and error.json are dropped with this run's record, so they never describe a run
 * whose record was not saved. Returns the held artifacts that were written and, when the earlier
 * record stayed, why. Throws only when the record cannot be saved, after a note says so.
 */
export async function endRun(
  ctx: EndingContext,
  { record, failure, note, artifacts = [] }: Ending,
  previous: RunRecord | undefined,
): Promise<Ended> {
  const kept = keepReason(previous, record);
  const saved = kept === undefined;
  if (saved) await saveRecord(ctx, record);
  else ctx.logger.warn(kept, { status: record.status });
  const written = saved ? await writeHeld(ctx, artifacts) : new Set<ArtifactName>();
  if (saved) await writeReviewSheet(ctx, record, artifacts);
  if (failure && saved) await saveErrorFile(ctx, failure, new Date(record.finishedAt));
  await sendOrHoldNote(ctx, note, failure);
  await pruneOldRuns(ctx);
  const { status, winner, counts } = record;
  ctx.logger.info('Run finished', { status, winner, counts });
  return saved ? { written } : { written, kept };
}

async function pruneOldRuns(ctx: EndingContext): Promise<void> {
  try {
    const pruned = await ctx.deps.store.prune(ctx.weekId, ctx.deps.config.keepWeeks);
    if (pruned.length > 0) ctx.logger.info('Pruned old runs', { pruned });
  } catch (error) {
    ctx.logger.error('Could not prune old runs', { error: errorMessage(error) });
  }
}
