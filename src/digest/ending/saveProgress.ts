import { errorMessage } from '../../shared/errors';
import type { RunRecord } from '../../store/runRecord';
import { keepReason } from './keepReason';
import { writeHeld } from './runFiles/heldArtifacts';
import type { EndingContext, HeldArtifact } from './types';

/**
 * The error of a record saved while its delivery is under way. It stays only when the run died
 * before `endRun` (SIGKILL, out of memory, power loss); the next run then resumes the week. It
 * names neither `--force` nor `Run aborted`, so a scheduler that reads it retries the week.
 */
export const DELIVERY_CUT_OFF =
  'The run stopped while it delivered the digest; a rerun sends it to the channels that lack it';

/**
 * Saves the record of a delivery under way, after each channel that took the digest. A run that
 * dies then leaves a partly delivered week, so the next run sends only to the channels that lack
 * the digest; without it the week had no record and every channel got the digest again. The held
 * files go with the record, as in `endRun`. A record that must not replace the stored one
 * (`keepReason`) is not saved. Never throws: the channel took the digest either way.
 */
export async function saveProgress(
  ctx: EndingContext,
  record: RunRecord,
  previous: RunRecord | undefined,
  held: readonly HeldArtifact[] = [],
): Promise<void> {
  try {
    const stored = await ctx.deps.store.getRunRecord(ctx.weekId);
    if (keepReason(previous, record, stored) !== undefined) return;
    await ctx.deps.store.saveRunRecord(record);
    await writeHeld(ctx, held);
  } catch (error) {
    ctx.logger.warn('Could not save the delivery progress', { error: errorMessage(error) });
  }
}
