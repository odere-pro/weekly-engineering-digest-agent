import { modelsByRole } from '../../config/profiles';
import type { RunStatus } from '../../domain/schemas';
import type { RunRecord } from '../../store/runRecord';
import type { RunContext } from '../chain/runContext';
import type { ChainOutcome } from '../chain/state';
import { recordError } from '../ending/runFiles/errorFile';

/** How the run ended: failed, else what settled it, else sent (or dry-run). */
export function statusOf(ctx: Pick<RunContext, 'dryRun'>, outcome: ChainOutcome): RunStatus {
  if (outcome.failure) return 'failed';
  if (outcome.state.settled) return outcome.state.settled.status;
  return ctx.dryRun ? 'dry-run' : 'sent';
}

/** The run record for what the chain produced; nothing in it comes from model or feed text. */
export function buildRecord(
  ctx: RunContext,
  outcome: ChainOutcome,
  status: RunStatus,
  finishedAt: Date,
): RunRecord {
  const { state, failure } = outcome;
  const { profile } = ctx.deps;
  return {
    runId: ctx.weekId,
    status,
    dryRun: ctx.dryRun,
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    profile: profile.name,
    modelsByRole: modelsByRole(profile),
    ...(ctx.deps.sampling && { sampling: ctx.deps.sampling }),
    timings: [...state.timings],
    counts: {
      collected: state.collected.length,
      afterGuardInput: state.kept.length,
      classified: state.scored.length,
      ...(state.afterProcess !== undefined && { afterProcess: state.afterProcess }),
      selected: state.selected.length,
      digestItems: state.winner?.draft.digest.items.length ?? 0,
    },
    failedSources: [...state.failedSources],
    disabledGuards: [...ctx.disabledGuards],
    drafts: [...state.drafts],
    winner: state.winner?.draft.writer ?? null,
    sentUrls: [...state.sentUrls],
    ...(state.fallback === true && { fallback: true }),
    ...(state.deliveredTo.length > 0 && { deliveredTo: [...state.deliveredTo] }),
    ...(failure && { error: recordError(failure) }),
  };
}
