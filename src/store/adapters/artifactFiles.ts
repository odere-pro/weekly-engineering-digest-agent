import type { ArtifactName } from '../RunStore';
import { DigestError } from '../../shared/errors';

/**
 * Artifact name to file name in the week folder. This one table decides which names are valid and
 * where each lives. `satisfies` fails typecheck when it lacks a name of the `ArtifactName` type
 * or has one the type does not, so a new artifact is added here and in `RunStore.ts` only.
 */
export const ARTIFACT_FILES = {
  'items.json': 'items.json',
  'scores.json': 'scores.json',
  'drafts.json': 'drafts.json',
  'digest.md': 'digest.md',
  'review.md': 'review.md',
  'error.json': 'error.json',
} as const satisfies Record<ArtifactName, string>;

/** The file for `name`, or a DigestError when it is not an artifact (never a path out of the folder). */
export function artifactFile(name: ArtifactName): string {
  // hasOwn, not `in`: "constructor" and "__proto__" are not artifacts.
  if (!Object.hasOwn(ARTIFACT_FILES, name)) {
    throw new DigestError(`Unknown artifact name "${name}"`);
  }
  return ARTIFACT_FILES[name];
}
