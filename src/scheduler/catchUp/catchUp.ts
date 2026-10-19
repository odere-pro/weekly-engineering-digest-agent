import type { RunStatus } from '../../domain/schemas';
import type { Clock } from '../../shared/clock';
import { errorMessage } from '../../shared/errors';
import { isoWeekId } from '../../shared/isoWeek';
import type { Logger } from '../../shared/telemetry';
import { firstSlotOfWeek, type SlotSource } from './firstSlotOfWeek';

/** Catch-up leaves a week that ended this way alone; a failed or dry-run week runs again. */
export const SETTLED: ReadonlySet<RunStatus> = new Set<RunStatus>(['sent', 'quiet', 'blocked']);

/** What catch-up reads from the scheduler's options. */
export interface CatchUpSettings {
  timeZone: string;
  clock: Clock;
  logger: Logger;
  /** How the week's saved run ended, if it has one. */
  runStatus: (weekId: string) => Promise<RunStatus | undefined>;
}

/** Runs the current week now if its slot has passed and the week has not settled. */
export async function catchUp(
  job: SlotSource,
  settings: CatchUpSettings,
  execute: (weekId: string, trigger: 'catch-up') => Promise<void>,
): Promise<void> {
  const { timeZone, clock, logger } = settings;
  const now = clock.now();
  const weekId = isoWeekId(now, timeZone);
  const slot = firstSlotOfWeek(job, weekId, timeZone);
  if (slot === null || slot.getTime() > now.getTime()) return;
  if (!(await isUnsettled(settings, weekId))) return;

  logger.info('Catching up on a missed run', { weekId, slot: slot.toISOString() });
  // Not awaited: a run takes minutes, and the caller needs the handle to be able to stop.
  void execute(weekId, 'catch-up');
}

/** True when the week has no run, or one that failed or was dry; false when the store fails. */
export async function isUnsettled(
  { runStatus, logger }: Pick<CatchUpSettings, 'runStatus' | 'logger'>,
  weekId: string,
): Promise<boolean> {
  try {
    const status = await runStatus(weekId);
    if (status === undefined || !SETTLED.has(status)) return true;
    logger.debug('No catch-up: the week has settled', { weekId, status });
    return false;
  } catch (error) {
    logger.error('Missed-week catch-up skipped: could not read the run store', {
      weekId,
      error: errorMessage(error),
    });
    return false;
  }
}
