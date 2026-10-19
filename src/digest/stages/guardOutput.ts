import { guardOutputStep } from '../../guards/guardOutput';
import { flaggedBy } from '../../guards/guardRun';
import type { Logger } from '../../shared/telemetry';
import type { DraftOutcome } from '../../store/runRecord';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { blocked, inWriterOrder, rejected } from './draftOutcomes';
import { withFallback } from './withFallback';

/**
 * The output guards over the drafts that passed the link and format checks (made in the write
 * step). The guards go through all drafts guard by guard, so one guard model is loaded at a time.
 * When no draft is left, the template-only fallback takes its place, or the run settles blocked.
 */
export async function guardOutput(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { outputGuards, config } = ctx.deps;
  const failing = state.checked.filter((entry) => entry.rejectedBy.length > 0);
  const clean = state.checked.filter((entry) => entry.rejectedBy.length === 0);
  const guarded = await guardOutputStep(
    clean.map((entry) => entry.draft),
    state.selected,
    { guards: outputGuards, config: config.guards.output, logger },
  );
  const passing = new Set(guarded.passed);
  const passed = clean.filter((entry) => passing.has(entry.draft));
  const drafts = inWriterOrder(ctx, [
    ...state.drafts,
    ...failing.map((entry) => rejected(entry.draft.writer, entry.rejectedBy)),
    ...guarded.rejected.map((entry) => rejected(entry.draft.writer, flaggedBy(entry.verdicts))),
    ...passed.map((entry): DraftOutcome => ({
      writer: entry.draft.writer,
      passed: true,
      rejectedBy: [],
    })),
  ]);
  const next = { ...state, drafts, passed };
  if (passed.length > 0) return next;
  return (await withFallback(ctx, next, logger)) ?? { ...next, settled: blocked(drafts) };
}
