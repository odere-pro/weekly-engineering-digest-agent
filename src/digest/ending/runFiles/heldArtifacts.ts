import { errorMessage } from '../../../shared/errors';
import type { ArtifactName } from '../../../store/RunStore';
import type { EndingContext, HeldArtifact } from '../types';

/** Best effort, like error.json: a file that cannot be written is logged and left out of the result. */
export async function writeHeld(
  ctx: EndingContext,
  artifacts: readonly HeldArtifact[],
): Promise<ReadonlySet<ArtifactName>> {
  const written = new Set<ArtifactName>();
  for (const { name, content } of artifacts) {
    try {
      await ctx.deps.store.saveArtifact(ctx.weekId, name, content);
      written.add(name);
    } catch (error) {
      ctx.logger.error(`Could not write ${name}`, { error: errorMessage(error) });
    }
  }
  return written;
}
