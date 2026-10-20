import { Cron } from 'croner';
import type { Config } from '../../../config/schema';
import type { Clock } from '../../../shared/clock';
import { errorMessage } from '../../../shared/errors';
import { fail, ok, warn, type CheckResult } from '../report/checkResult';

const LABEL = 'schedule';

/**
 * Builds the cron job the way `startScheduler` does (same pattern, same `timezone` option), so
 * `digest serve` and doctor refuse the same cron and zone, and says when it fires next. The job
 * is paused: it never arms a timer, and it is stopped before this returns.
 */
export function checkSchedule(schedule: Config['schedule'], clock: Clock): CheckResult {
  const { cron, timeZone } = schedule;
  let next: Date | null;
  try {
    const job = new Cron(cron, { timezone: timeZone, paused: true });
    next = job.nextRun(clock.now());
    job.stop();
  } catch (cause) {
    return fail(
      LABEL,
      `Invalid schedule (cron "${cron}", time zone "${timeZone}"): ${errorMessage(cause)}`,
      'set "schedule.cron" to five fields, for example "45 7 * * 1", and "schedule.timeZone" to an ' +
        'IANA name such as "Europe/Berlin" in digest.config.json; "digest serve" refuses to start without them',
    );
  }
  if (next === null) {
    return warn(
      LABEL,
      `cron "${cron}" never fires (no date matches it)`,
      'set "schedule.cron" to a pattern that matches a day, for example "45 7 * * 1"',
    );
  }
  return ok(LABEL, `next run ${next.toISOString()} (cron "${cron}", ${timeZone})`);
}
