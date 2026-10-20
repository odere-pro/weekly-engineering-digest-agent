import { errorMessage } from '../shared/errors';
import type { RunLock } from '../store/RunStore';
import { runContext, type RunContext } from './chain/runContext';
import { settle } from './chain/settle';
import { EMPTY_STATE, type ChainOutcome } from './chain/state';
import { reachedAChannel } from './ending/keepReason';
import { abortedError } from './ending/notes/unretriable';
import { assertModelsReady } from './health/assertModelsReady';
import { finish } from './record/finish';
import { resumed } from './record/resumed';
import { skipped } from './record/skipped';
import { loadPartDelivery } from './resume/resumeDelivery';
import { chainSteps } from './stages/chainSteps';
import type { DigestDeps, RunOptions, RunResult } from './types';
import { runWorkflow } from './workflow';

const WORKFLOW_ID = 'digest';

/**
 * The whole chain: collect, guard-input, classify, process, write, guard-output, select, deliver
 * (W2-01). A rerun of a partly delivered week only finishes the delivery (W2-08).
 */
export async function runDigest(deps: DigestDeps, options: RunOptions = {}): Promise<RunResult> {
  const ctx = runContext(deps, options);
  return deps.tracer.span('runDigest', { runId: ctx.weekId, dryRun: ctx.dryRun }, async () => {
    if (!options.force && (await deps.store.hasSentDigest(ctx.weekId))) return skipped(ctx);
    const lock = await deps.store.acquireLock(ctx.weekId);
    try {
      // Read again under the lock: a run that held it may have just sent this week.
      const previous = await deps.store.getRunRecord(ctx.weekId);
      if (previous?.status === 'sent' && !options.force) return skipped(ctx);
      const part = options.force || ctx.dryRun ? undefined : await loadPartDelivery(ctx, previous);
      if (part) return await resumed(ctx, part);
      const chainCtx = {
        ...ctx,
        holdArtifacts: reachedAChannel(previous),
        previousRecord: previous,
      };
      return await finish(chainCtx, await runChain(chainCtx), previous);
    } finally {
      await releaseLock(ctx, lock);
    }
  });
}

/** Checks the signal and Ollama, then runs the stages; a failure keeps the state so far. */
function runChain(ctx: RunContext): Promise<ChainOutcome> {
  return settle(ctx, async () => {
    const stopped = abortedError(ctx.signal);
    if (stopped) throw stopped;
    await assertModelsReady(ctx);
    return runWorkflow(WORKFLOW_ID, chainSteps(ctx), EMPTY_STATE);
  });
}

async function releaseLock(ctx: RunContext, lock: RunLock): Promise<void> {
  try {
    await lock.release();
  } catch (error) {
    ctx.logger.error('Could not release the run lock', { error: errorMessage(error) });
  }
}
