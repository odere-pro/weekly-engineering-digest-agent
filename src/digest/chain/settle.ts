import { errorMessage } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { StepFailure } from './failures';
import { EMPTY_STATE, type ChainOutcome, type ChainState } from './state';

/** Never rejects: a failure comes back with the state of the steps that finished before it. */
export async function settle(
  ctx: { readonly logger: Logger },
  run: () => Promise<ChainState>,
): Promise<ChainOutcome> {
  try {
    return { state: await run() };
  } catch (error) {
    if (error instanceof StepFailure) {
      return { state: error.state, failure: { error: error.cause, step: error.step } };
    }
    ctx.logger.error('Run failed outside a step', { error: errorMessage(error) });
    return { state: EMPTY_STATE, failure: { error } };
  }
}
