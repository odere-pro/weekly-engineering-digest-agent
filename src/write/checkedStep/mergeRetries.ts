import type { CodeChecked } from './types';

export interface MergedRetries {
  /** One entry per writer that had a first draft: its retry when there is one, else the first. */
  readonly checked: CodeChecked[];
  /** The entries of `checked` that came from a retry, in the same order. */
  readonly retried: CodeChecked[];
}

/**
 * A retry replaces its writer's first draft (writers are unique, the config schema says so). A
 * writer whose retry produced no draft keeps its first one. A retry for a writer with no first
 * draft is not taken: only writers that had a draft are retried.
 */
export function mergeRetries(
  first: readonly CodeChecked[],
  retries: readonly CodeChecked[],
): MergedRetries {
  const again = new Map(retries.map((entry) => [entry.draft.writer, entry]));
  const checked = first.map((entry) => again.get(entry.draft.writer) ?? entry);
  const retried = checked.filter((entry) => again.get(entry.draft.writer) === entry);
  return { checked, retried };
}
