import { DigestError, errorMessage } from '../../shared/errors';
import type { RunRecord } from '../../store/runRecord';
import { sendFailureNote } from './notes/failureNotes';
import type { EndingContext } from './types';

/**
 * The run record could not be saved. `endRun` has already sent a note saying so, so a caller that
 * held back an earlier attempt's note must not send that one as well.
 */
export class RecordNotSavedError extends DigestError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'RecordNotSavedError';
  }
}

/** Alerts, then throws, when the record cannot be saved. */
export async function saveRecord(ctx: EndingContext, record: RunRecord): Promise<void> {
  try {
    await ctx.deps.store.saveRunRecord(record);
  } catch (error) {
    const outcome = record.error ? `failed: ${record.error.message}` : `ended ${record.status}`;
    const message = `Could not save the run record (${errorMessage(error)}); the run ${outcome}`;
    ctx.logger.error('Could not save the run record', { error: errorMessage(error) });
    await sendFailureNote(ctx, { weekId: ctx.weekId, message });
    throw new RecordNotSavedError(message, { cause: error });
  }
}
