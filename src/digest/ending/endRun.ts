import { errorMessage } from '../../shared/errors';
import type { ArtifactName } from '../../store/RunStore';
import type { RunRecord } from '../../store/runRecord';
import { KEPT_LOST_LOCK_REASON, keepReason, leftToLockHolder } from './keepReason';
import { clearFailureNotes, sendOrHoldNote } from './notes/failureNotes';
import { settleErrorFile } from './runFiles/errorFile';
import { writeHeld } from './runFiles/heldArtifacts';
import { writeReviewSheet } from './runFiles/reviewSheet';
import { saveRecord } from './saveRecord';
import type { Ended, Ending, EndingContext } from './types';

/**
 * Ends a run (W2-08): the record, the held artifacts, error.json, the failure note, pruning.
 * `previous` is the week's record before this run; it may stay (see `keepReason`), and then the
 * held artifacts and error.json are dropped with this run's record, so they never describe a run
 * whose record was not saved. The store is read again first, so a run that lost its lock keeps the
 * record of the run that delivered the week meanwhile; a run that knows it lost its lock writes
 * nothing at all (`endLostRun`). Returns the held artifacts that were written and, when the earlier
 * record stayed, why. A saved record that did not fail removes an earlier attempt's error.json; a
 * sent one also clears every channel's failure note. Throws only when the record cannot be saved,
 * after a note says so.
 */
export async function endRun(
  ctx: EndingContext,
  ending: Ending,
  previous: RunRecord | undefined,
): Promise<Ended> {
  if (leftToLockHolder(ctx.lockLost, previous, ending.record)) return endLostRun(ctx, ending);
  const { record, failure, note, artifacts = [] } = ending;
  const kept = keepReason(previous, record, await storedRecord(ctx, previous));
  const saved = kept === undefined;
  if (saved) await saveRecord(ctx, record);
  else ctx.logger.warn(kept, { status: record.status });
  const written = saved ? await writeHeld(ctx, artifacts) : new Set<ArtifactName>();
  if (saved) await writeReviewSheet(ctx, record, artifacts);
  if (saved) await settleErrorFile(ctx, failure, new Date(record.finishedAt));
  if (saved && record.status === 'sent') await clearFailureNotes(ctx);
  await sendOrHoldNote(ctx, note, failure);
  await pruneOldRuns(ctx);
  const { status, winner, counts } = record;
  ctx.logger.info('Run finished', { status, winner, counts });
  return saved ? { written } : { written, kept };
}

/**
 * Ends a run that lost its lock and delivered nothing new: the week's record, files and pruning
 * belong to the run that took the lock over. Only the note goes; a `Run aborted` one always does.
 */
async function endLostRun(ctx: EndingContext, { record, failure, note }: Ending): Promise<Ended> {
  ctx.logger.warn(KEPT_LOST_LOCK_REASON, { status: record.status });
  await sendOrHoldNote(ctx, note, failure);
  const { status, winner, counts } = record;
  ctx.logger.info('Run finished', { status, winner, counts });
  return { written: new Set<ArtifactName>(), kept: KEPT_LOST_LOCK_REASON };
}

/**
 * The week's record as the store holds it now. A run that lost its lock (it stalled past the
 * heartbeat timeout) can find that another run delivered the week since `previous` was read; the
 * record of this run must not replace that one. A store that cannot be read again leaves `previous`.
 */
async function storedRecord(
  ctx: EndingContext,
  previous: RunRecord | undefined,
): Promise<RunRecord | undefined> {
  try {
    return await ctx.deps.store.getRunRecord(ctx.weekId);
  } catch (error) {
    ctx.logger.warn('Could not read the week record again before saving', {
      error: errorMessage(error),
    });
    return previous;
  }
}

async function pruneOldRuns(ctx: EndingContext): Promise<void> {
  try {
    const pruned = await ctx.deps.store.prune(ctx.weekId, ctx.deps.config.keepWeeks);
    if (pruned.length > 0) ctx.logger.info('Pruned old runs', { pruned });
  } catch (error) {
    ctx.logger.error('Could not prune old runs', { error: errorMessage(error) });
  }
}
