import type { DraftOutcome } from '../../store/runRecord';
import type { RunContext } from '../chain/runContext';
import type { Settled } from '../chain/state';

/** A writer's draft that did not pass, with the checks that rejected it. */
export function rejected(writer: string, rejectedBy: readonly string[]): DraftOutcome {
  return { writer, passed: false, rejectedBy: [...rejectedBy] };
}

/** The profile's writers first, in their order; a writer it does not list goes last. */
export function inWriterOrder(
  ctx: Pick<RunContext, 'deps'>,
  outcomes: readonly DraftOutcome[],
): DraftOutcome[] {
  const rank = (writer: string): number => {
    const index = ctx.deps.profile.writers.indexOf(writer);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  return outcomes.toSorted((a, b) => rank(a.writer) - rank(b.writer));
}

/** Names writers and check ids only: both come from config and code, never from a model. */
export function blocked(drafts: readonly DraftOutcome[]): Settled {
  const reasons = drafts.map((draft) => `${draft.writer} (${draft.rejectedBy.join(', ')})`);
  const detail = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
  return { status: 'blocked', note: `every draft was rejected${detail}` };
}
