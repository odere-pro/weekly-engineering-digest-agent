import { areaHintsOf, classifyStep } from '../../src/classify/classify';
import type { DigestDeps } from '../../src/digest/types';
import { DigestError } from '../../src/shared/errors';
import type { ClassifierResult } from '../metrics/ranking/classifier';
import type { ClassifierCase } from '../schema';

/**
 * The labeled classifier cases through the app's own classify step, with the source area hints
 * and, when `models.rescoreWithWriter` is on (off by default), the writer rescoring.
 */
export async function classifyCases(
  app: DigestDeps,
  cases: readonly ClassifierCase[],
): Promise<ClassifierResult[]> {
  if (cases.length === 0) return [];
  const scored = await classifyStep(
    cases.map((c) => c.item),
    {
      model: app.model,
      focusAreas: app.config.focusAreas,
      logger: app.logger,
      areaHints: areaHintsOf(app.config.sources),
      rescoreWithWriter: app.config.models.rescoreWithWriter,
      minRelevance: app.config.thresholds.minRelevance,
    },
  );
  if (scored.length !== cases.length) {
    throw new DigestError(`classify returned ${scored.length} results for ${cases.length} cases`, {
      step: 'classify',
    });
  }
  return cases.flatMap((c, i) => {
    const classification = scored[i]?.classification;
    return classification
      ? [
          {
            expected: c.expected,
            actual: { area: classification.area, relevance: classification.relevance },
          },
        ]
      : [];
  });
}
