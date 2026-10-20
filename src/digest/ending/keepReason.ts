import type { RunRecord } from '../../store/runRecord';

/** Why a sent week's record stayed: the run may still have reached some channels, then failed. */
export const KEPT_SENT_REASON = 'Kept the sent run record; this forced run did not end sent';
export const KEPT_PARTLY_REASON =
  'Kept the partly delivered run record; this run delivered nothing';
/** Why a record another run saved while this one worked stayed: that run reached a channel first. */
export const KEPT_OTHER_RUN_REASON =
  'Kept the run record of another run that delivered this week while this one worked';
/** Why a run that lost its lock saved nothing: the week belongs to the run that took the lock. */
export const KEPT_LOST_LOCK_REASON =
  'Kept the week for the run that took over the lock; this run lost it';

/**
 * A run never replaces a record that got further with delivery. A sent week that looked unsent
 * would be sent again; a partly delivered one that lost its channels would resend to them.
 * `previous` is the week's record when the run began; `stored` is the one in the store now (it
 * differs when the run lost its lock and another run delivered the week meanwhile).
 */
export function keepReason(
  previous: RunRecord | undefined,
  record: RunRecord,
  stored: RunRecord | undefined = previous,
): string | undefined {
  const earlier = keepEarlier(previous, record);
  if (earlier !== undefined) return earlier;
  const other = deliveredMeanwhile(previous, stored) && keepEarlier(stored, record) !== undefined;
  return other ? KEPT_OTHER_RUN_REASON : undefined;
}

function keepEarlier(earlier: RunRecord | undefined, record: RunRecord): string | undefined {
  if (earlier?.status === 'sent') {
    return record.status === 'sent' ? undefined : KEPT_SENT_REASON;
  }
  return reachedAChannel(earlier) && !reachedAChannel(record) ? KEPT_PARTLY_REASON : undefined;
}

/**
 * True when a run that lost its lock must leave the week alone: it reached no channel `previous`
 * lacked. A run that did (it sent before it saw the loss) must still save its record, or the run
 * that took the lock over would send the week again.
 */
export function leftToLockHolder(
  lockLost: AbortSignal | undefined,
  previous: RunRecord | undefined,
  record: RunRecord,
): boolean {
  return lockLost?.aborted === true && !deliveredMeanwhile(previous, record);
}

/** A sent record, or a failed one that some channel took: the week must not be sent from scratch. */
export function reachedAChannel(record: RunRecord | undefined): boolean {
  return record?.status === 'sent' || (record?.deliveredTo?.length ?? 0) > 0;
}

/**
 * True when `stored` reached a channel that `started` had not: another run delivered the week
 * since `started` was read. A forced run over a sent week sees the same record twice and is not it.
 */
export function deliveredMeanwhile(
  started: RunRecord | undefined,
  stored: RunRecord | undefined,
): boolean {
  if (stored === undefined || !reachedAChannel(stored)) return false;
  if (stored.status === 'sent' && started?.status !== 'sent') return true;
  const had = new Set(started?.deliveredTo);
  return (stored.deliveredTo ?? []).some((channel) => !had.has(channel));
}
