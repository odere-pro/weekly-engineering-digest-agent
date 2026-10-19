import { DigestError } from '../../../shared/errors';

const SINCE_PATTERN = /^(\d+)d$/;
const MIN_SINCE_DAYS = 1;
const MAX_SINCE_DAYS = 31;

/** "7d" is 7 days, as for `digest run`. Undefined means "use the configured window". */
export function parseSince(since: string | undefined): number | undefined {
  if (since === undefined) return undefined;
  const days = Number(SINCE_PATTERN.exec(since)?.[1]);
  if (!Number.isInteger(days) || days < MIN_SINCE_DAYS || days > MAX_SINCE_DAYS) {
    throw new DigestError(
      `Invalid --since "${since}". Use a number of days from ${MIN_SINCE_DAYS}d to ${MAX_SINCE_DAYS}d, for example 7d.`,
    );
  }
  return days;
}
