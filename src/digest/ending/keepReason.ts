import type { RunRecord } from '../../store/runRecord';

/** Why a sent week's record stayed: the run may still have reached some channels, then failed. */
export const KEPT_SENT_REASON = 'Kept the sent run record; this forced run did not end sent';
export const KEPT_PARTLY_REASON =
  'Kept the partly delivered run record; this run delivered nothing';

/**
 * A run never replaces a record that got further with delivery. A sent week that looked unsent
 * would be sent again; a partly delivered one that lost its channels would resend to them.
 */
export function keepReason(previous: RunRecord | undefined, record: RunRecord): string | undefined {
  if (previous?.status === 'sent') {
    return record.status === 'sent' ? undefined : KEPT_SENT_REASON;
  }
  return reachedAChannel(previous) && !reachedAChannel(record) ? KEPT_PARTLY_REASON : undefined;
}

/** A sent record, or a failed one that some channel took: the week must not be sent from scratch. */
export function reachedAChannel(record: RunRecord | undefined): boolean {
  return record?.status === 'sent' || (record?.deliveredTo?.length ?? 0) > 0;
}
