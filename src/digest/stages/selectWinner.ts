import { DigestError } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';
import type { JudgeScore } from '../../select/judgeScore';
import { selectStep, type SelectOutput } from '../../select/select';
import type { DraftOutcome } from '../../store/runRecord';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { keepArtifact } from './keepArtifact';

/** The judge runs only when the profile has one and two or more drafts passed. */
export async function selectWinner(
  ctx: RunContext,
  state: ChainState,
  logger: Logger,
): Promise<ChainState> {
  const { model, profile, config } = ctx.deps;
  const [first, ...others] = state.passed;
  if (!first) throw new DigestError('select ran without a passing draft', { step: 'select' });
  const selection: SelectOutput =
    profile.judge !== null && others.length > 0
      ? await selectStep(
          state.passed.map((entry) => entry.draft),
          state.selected,
          { model, focusAreas: config.focusAreas, writerOrder: profile.writers, logger },
        )
      : { winner: first.draft, scores: [], judged: false };
  const winner = state.passed.find((entry) => entry.draft === selection.winner);
  if (!winner)
    throw new DigestError('The judge picked a draft it was not given', { step: 'select' });
  const held = await keepArtifact(ctx, state, 'digest.md', winner.markdown);
  logger.info('Winner chosen', { writer: winner.draft.writer, judged: selection.judged });
  return { ...held, winner, drafts: withScores(state.drafts, selection.scores) };
}

function withScores(
  drafts: readonly DraftOutcome[],
  scores: readonly JudgeScore[],
): DraftOutcome[] {
  return drafts.map((draft) => {
    const score = scores.find((entry) => entry.writer === draft.writer);
    return score ? { ...draft, score } : draft;
  });
}
