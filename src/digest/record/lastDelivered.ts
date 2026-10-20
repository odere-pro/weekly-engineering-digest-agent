import { errorMessage } from '../../shared/errors';
import { compareWeekIds } from '../../shared/isoWeek';
import type { RunRecord } from '../../store/runRecord';
import type { RunContext } from '../chain/runContext';
import { reachedAChannel } from '../ending/keepReason';

/**
 * The latest record of a week before the run's that reached a channel (`RunContext.lastDelivered`).
 * None when there is none, or when the runs cannot be read: the run then keeps the usual window.
 */
export async function lastDelivered(ctx: RunContext): Promise<RunRecord | undefined> {
  try {
    const runs = await ctx.deps.store.listRuns();
    return runs.find((run) => compareWeekIds(run.runId, ctx.weekId) < 0 && reachedAChannel(run));
  } catch (error) {
    ctx.logger.warn('Could not read the earlier runs; collecting over the usual window', {
      error: errorMessage(error),
    });
    return undefined;
  }
}
