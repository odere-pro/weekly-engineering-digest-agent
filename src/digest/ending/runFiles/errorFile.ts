import { errorMessage } from '../../../shared/errors';
import type { RunRecord } from '../../../store/runRecord';
import type { EndingContext, Failure } from '../types';
import { toJson } from './runFiles';

/** The error run.json holds: the message and the step, never the stack. */
export function recordError(failure: Failure): NonNullable<RunRecord['error']> {
  return { message: errorMessage(failure.error), step: failure.step };
}

/** Best effort: run.json already holds the error; this file only adds the stack. */
export async function saveErrorFile(ctx: EndingContext, failure: Failure, at: Date): Promise<void> {
  const { error, step } = failure;
  const content = toJson({
    runId: ctx.weekId,
    step,
    name: error instanceof Error ? error.name : 'Error',
    message: errorMessage(error),
    at: at.toISOString(),
    stack: error instanceof Error ? error.stack : undefined,
  });
  try {
    await ctx.deps.store.saveArtifact(ctx.weekId, 'error.json', content);
  } catch (saveError) {
    ctx.logger.error('Could not write error.json', { error: errorMessage(saveError) });
  }
}
