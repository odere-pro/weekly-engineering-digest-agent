import type { StepName } from '../../domain/schemas';
import { errorMessage } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import { abortedError } from '../ending/notes/unretriable';
import type { WorkflowStep } from '../workflow';
import { PartialFailure, StepFailure } from './failures';
import type { RunContext } from './runContext';
import type { ChainState } from './state';

/** One stage of the chain: the work of a step, with the logger bound to the run and the step. */
export type StageFn = (ctx: RunContext, state: ChainState, logger: Logger) => Promise<ChainState>;

/**
 * Skips a settled run; stops one whose signal fired, keeping the steps that finished; otherwise
 * times, traces and logs the step with the run id and step.
 */
export function stage(ctx: RunContext, step: StepName, fn: StageFn): WorkflowStep<ChainState> {
  return {
    id: step,
    run: (state) => {
      if (state.settled) return Promise.resolve(state);
      const stopped = abortedError(ctx.signal, step);
      if (!stopped) return timed(ctx, step, state, fn);
      ctx.logger.warn('Run aborted', { step, reason: errorMessage(stopped.cause) });
      return Promise.reject(new StepFailure(step, state, stopped));
    },
  };
}

async function timed(
  ctx: RunContext,
  step: StepName,
  state: ChainState,
  fn: StageFn,
): Promise<ChainState> {
  const { clock, tracer } = ctx.deps;
  const logger = ctx.logger.child({ step });
  const startedMs = clock.now().getTime();
  const timing = () => ({ step, ms: Math.max(0, clock.now().getTime() - startedMs) });
  try {
    const next = await tracer.span(step, { runId: ctx.weekId, step }, () => fn(ctx, state, logger));
    const done = timing();
    logger.info('Step finished', { ms: done.ms });
    const settled = next.settled && { ...next.settled, step };
    return { ...next, ...(settled && { settled }), timings: [...next.timings, done] };
  } catch (error) {
    const failed = timing();
    const partial = error instanceof PartialFailure;
    const cause = partial ? error.cause : error;
    const kept = partial ? error.state : state;
    logger.error('Step failed', { ms: failed.ms, error: errorMessage(cause) });
    throw new StepFailure(step, { ...kept, timings: [...kept.timings, failed] }, cause);
  }
}
