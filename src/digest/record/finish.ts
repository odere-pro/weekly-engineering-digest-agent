import type { FailureNote } from '../../delivery/Delivery';
import { exitCodeFor } from '../../domain/schemas';
import type { RunRecord } from '../../store/runRecord';
import type { RunContext } from '../chain/runContext';
import type { ChainOutcome } from '../chain/state';
import { endRun } from '../ending/endRun';
import { failureNote } from '../ending/notes/failureNotes';
import { winnerMessage } from '../ending/shipping/digestMessage';
import type { RunResult } from '../types';
import { buildRecord, statusOf } from './buildRecord';

/**
 * Ends a run that went through the chain: builds the record, hands it to `endRun` with the note
 * and the held files, and shapes the result. `previous`: the week's record before this run, if any.
 */
export async function finish(
  ctx: RunContext,
  outcome: ChainOutcome,
  previous: RunRecord | undefined,
): Promise<RunResult> {
  const { failure, state } = outcome;
  const record = buildRecord(ctx, outcome, statusOf(ctx, outcome), ctx.deps.clock.now());
  const { written, kept } = await endRun(
    ctx,
    { record, failure, note: noteFor(ctx, outcome), artifacts: state.held },
    previous,
  );
  // `digest run` prints digest.md's path whenever markdown is set: only for a file this run wrote.
  const digestWritten = !ctx.holdArtifacts || written.has('digest.md');
  const markdown = digestWritten ? state.winner?.markdown : undefined;
  const message =
    state.winner && winnerMessage(ctx, state.winner, state.fallback === true, state.eligible);
  return {
    record,
    exitCode: exitCodeFor(record.status),
    markdown,
    ...(message && { message }),
    ...(kept && { kept }),
  };
}

/** The failure note of a failed run, or the note of a run settled with one; none for a plain quiet week. */
export function noteFor(
  ctx: Pick<RunContext, 'weekId'>,
  outcome: ChainOutcome,
): FailureNote | undefined {
  const { failure, state } = outcome;
  if (failure) return failureNote(ctx.weekId, failure);
  const note = state.settled?.note;
  return note === undefined
    ? undefined
    : { weekId: ctx.weekId, step: state.settled?.step, message: note };
}
