import type { Source } from '../../../domain/schemas';
import { DigestError } from '../../../shared/errors';

/** The named sources in config order; an id the config does not have is an error. */
export function selectSources(
  all: readonly Source[],
  wanted: readonly string[] | undefined,
): Source[] {
  if (wanted === undefined || wanted.length === 0) return [...all];
  const known = new Set(all.map((source) => source.id));
  const unknown = [...new Set(wanted)].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new DigestError(
      `Unknown source: ${unknown.join(', ')}. Sources in the config: ${[...known].join(', ')}`,
    );
  }
  const chosen = new Set(wanted);
  return all.filter((source) => chosen.has(source.id));
}
