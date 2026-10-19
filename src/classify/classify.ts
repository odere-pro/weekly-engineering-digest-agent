import { classifyError } from './answers/classifyError';
import { fromAnswers } from './answers/fromAnswers';
import { classifyInBatches } from './batching/classifyInBatches';
import type { ScoredItem } from './classification';
import { areaOptions, classifyQuestions, classifyState } from './classifyPrompt';
import { rescoreFiltered } from './rescore/rescoreFiltered';
import type { ClassifierDeps } from './types';
import { type Item, type Source } from '../domain/schemas';
import type { Clock } from '../shared/clock';
import { startProgress } from '../shared/progress';

export interface ClassifyDeps extends ClassifierDeps {
  /**
   * decide: one decision call per item (default). generate: JSON batches of 10, for a model that
   * cannot answer decisions. No run sets it (the digest, the evals and the threshold capture use
   * decide); the tests pin the generate path.
   */
  mode?: 'decide' | 'generate';
  /**
   * Score the items that pass `minRelevance` once more with the writer model (W6-08). Off by
   * default; call sites pass `config.models.rescoreWithWriter`.
   */
  rescoreWithWriter?: boolean;
  /** The relevance floor of the process step; required when `rescoreWithWriter` is on. */
  minRelevance?: number;
  /** Times the `Progress` lines of decide mode; the system clock when absent. */
  clock?: Clock;
}

/** Builds `areaHints` from the configured sources; sources without an `area` are skipped. */
export function areaHintsOf(sources: readonly Source[]): ReadonlyMap<string, string> {
  return new Map(
    sources.flatMap((source): [string, string][] =>
      source.area === undefined ? [] : [[source.id, source.area]],
    ),
  );
}

/**
 * Scores relevance, area, hype and minor release for every item (W1-07). Returns the items in
 * input order; thresholds are applied later by the process step.
 */
export async function classifyStep(
  items: readonly Item[],
  deps: ClassifyDeps,
): Promise<ScoredItem[]> {
  if (items.length === 0) return [];
  const rescoreFloor = rescoreFloorOf(deps);
  const mode = deps.mode ?? 'decide';
  const decided =
    mode === 'generate' ? await classifyInBatches(items, deps) : await classifyEach(items, deps);
  const scored =
    rescoreFloor === undefined ? decided : await rescoreFiltered(decided, rescoreFloor, deps);
  deps.logger.info('Classified items', { mode, count: items.length });
  return scored;
}

/** The relevance floor to rescore above, or undefined when the writer pass is off. */
function rescoreFloorOf(deps: ClassifyDeps): number | undefined {
  if (!deps.rescoreWithWriter) return undefined;
  if (deps.minRelevance === undefined)
    throw classifyError('rescoreWithWriter needs minRelevance (config.thresholds.minRelevance)');
  return deps.minRelevance;
}

/** Decide mode: one decision call per item, one at a time (the endpoint takes one state). */
async function classifyEach(items: readonly Item[], deps: ClassifyDeps): Promise<ScoredItem[]> {
  const questions = classifyQuestions(deps.focusAreas);
  const areas = new Set(areaOptions(deps.focusAreas));
  const scored: ScoredItem[] = [];
  const progress = startProgress({
    label: 'classify',
    total: items.length,
    logger: deps.logger,
    clock: deps.clock,
  });
  for (const item of items) {
    deps.signal?.throwIfAborted();
    const { answers } = await deps.model.decide({
      role: 'classify',
      state: classifyState(item, deps.areaHints?.get(item.sourceId)),
      questions,
      signal: deps.signal,
    });
    scored.push({ ...item, classification: fromAnswers(item.id, answers, areas) });
    progress.tick();
  }
  return scored;
}
