import type { ArtifactName } from '../../store/RunStore';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';

/** Writes a run file now, or holds it for `endRun` when the week's files must stay as they are. */
export async function keepArtifact(
  ctx: RunContext,
  state: ChainState,
  name: ArtifactName,
  content: string,
): Promise<ChainState> {
  if (!ctx.holdArtifacts) {
    await ctx.deps.store.saveArtifact(ctx.weekId, name, content);
    return state;
  }
  return { ...state, held: [...state.held, { name, content }] };
}
