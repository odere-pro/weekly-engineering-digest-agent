import type { ArtifactName } from '../../store/RunStore';
import type { RunContext } from '../chain/runContext';
import type { ChainState } from '../chain/state';
import { abortedError } from '../ending/notes/unretriable';

/**
 * Writes a run file now, or holds it for `endRun` when the week's files must stay as they are.
 * A run that lost its lock writes nothing: the week's folder belongs to the run that took it over.
 */
export async function keepArtifact(
  ctx: RunContext,
  state: ChainState,
  name: ArtifactName,
  content: string,
): Promise<ChainState> {
  if (!ctx.holdArtifacts) {
    const lost = abortedError(ctx.lockLost);
    if (lost) throw lost;
    await ctx.deps.store.saveArtifact(ctx.weekId, name, content);
    return state;
  }
  return { ...state, held: [...state.held, { name, content }] };
}
