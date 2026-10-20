import type { Config } from '../../config/schema';

/**
 * Whether the model input guards run on every item before classify, as before PERF-2. Only for
 * `models.rescoreWithWriter`: it sends items to a writer model during classify, and a model that
 * writes text must never read an unguarded item. Otherwise they check the ranked candidates after
 * `process` (`guardCandidates`), and only the rule guard runs before classify.
 */
export function modelGuardsFirst(config: Pick<Config, 'models'>): boolean {
  return config.models.rescoreWithWriter;
}
