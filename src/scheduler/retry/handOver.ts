import type { RunResult } from '../../digest/types';
import { errorMessage } from '../../shared/errors';
import type { AttemptSettings, RetryWhere } from './types';

const SENDING_HELD_NOTE = 'Sending the failure note held back for a retry that will not run';
const SENDING_OWN_NOTE = 'Sending the failure note of a week that ended with no run record';

type Hooks = Pick<AttemptSettings, 'onGiveUp' | 'onNoRecord' | 'logger'>;

/**
 * The week ends and the retry its failed attempt held a note for is not coming: send the one note
 * it owes. That is the failed result an attempt held back, through `onGiveUp`; with none held,
 * `note`, which the scheduler composed for a week whose run left no record, through `onNoRecord`.
 * Never both, so the week gets one note. Nothing goes out when neither exists. A hook that fails
 * is logged, never thrown: the service must stay up.
 */
export async function handOver(
  hooks: Hooks,
  owed: RunResult | undefined,
  where: RetryWhere,
  reason: string,
  note?: string,
): Promise<void> {
  const { onGiveUp, onNoRecord, logger } = hooks;
  const { weekId, trigger } = where;
  if (owed !== undefined) {
    if (onGiveUp === undefined) return;
    logger.warn(SENDING_HELD_NOTE, { weekId, trigger, reason });
    await guarded(logger, 'Could not send the failure note held back', where, () =>
      onGiveUp(weekId, owed),
    );
    return;
  }
  if (note === undefined || onNoRecord === undefined) return;
  logger.warn(SENDING_OWN_NOTE, { weekId, trigger, reason });
  await guarded(logger, 'Could not send the scheduler failure note', where, () =>
    onNoRecord(weekId, note),
  );
}

async function guarded(
  logger: Hooks['logger'],
  failure: string,
  { weekId, trigger }: RetryWhere,
  send: () => Promise<void>,
): Promise<void> {
  try {
    await send();
  } catch (error) {
    logger.error(failure, { weekId, trigger, error: errorMessage(error) });
  }
}
