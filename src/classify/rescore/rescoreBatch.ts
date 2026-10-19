import { z } from 'zod';
import { GENERATE_TEMPERATURE, MAX_RELEVANCE } from '../batching/limits';
import type { ScoredItem } from '../classification';
import { areaOptions, rescorePrompt, rescoreSystem } from '../classifyPrompt';
import type { ClassifierDeps } from '../types';
import { generateStructured } from '../../models/structured';
import { errorMessage } from '../../shared/errors';

/** What the writer says about one item. */
export interface Rescore {
  relevance: number;
  area: string;
  /** True only when the writer was highly confident in the area. */
  confidentArea: boolean;
}

/**
 * Asks the writer model to rescore one batch. The first answer for an id wins. A batch that fails
 * (bad JSON after the repair, a model error) returns no answers, so its items keep the decider's
 * scores; only an abort propagates.
 */
export async function rescoreBatch(
  batch: readonly ScoredItem[],
  deps: ClassifierDeps,
): Promise<Map<string, Rescore>> {
  const schema = rescoreSchema(
    batch.map((item) => item.id),
    areaOptions(deps.focusAreas),
  );
  try {
    const { value, repaired } = await generateStructured(
      deps.model,
      {
        role: 'write',
        system: rescoreSystem(deps.focusAreas),
        prompt: rescorePrompt(batch, deps.areaHints),
        temperature: GENERATE_TEMPERATURE,
      },
      schema,
      'classify',
    );
    if (repaired)
      deps.logger.warn('Writer rescoring output was repaired', {
        itemIds: batch.map((item) => item.id),
      });
    const answers = new Map<string, Rescore>();
    for (const answer of value.items) {
      if (answers.has(answer.itemId)) continue;
      answers.set(answer.itemId, {
        relevance: answer.relevance,
        area: answer.area,
        confidentArea: answer.confidence === 'high',
      });
    }
    const missing = batch.filter((item) => !answers.has(item.id)).map((item) => item.id);
    if (missing.length > 0)
      deps.logger.warn('Writer left items out of the rescore; keeping the classifier scores', {
        itemIds: missing,
      });
    return answers;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    deps.logger.warn('Writer rescoring failed; keeping the classifier scores for this batch', {
      itemIds: batch.map((item) => item.id),
      error: errorMessage(error),
    });
    return new Map();
  }
}

/** Ids and areas are enums, so the writer can only name items and areas it was given. */
export function rescoreSchema(ids: readonly string[], areas: readonly string[]) {
  return z.object({
    items: z.array(
      z.object({
        itemId: z.enum(ids),
        relevance: z.number().int().min(0).max(MAX_RELEVANCE),
        area: z.enum(areas),
        confidence: z.enum(['low', 'high']),
      }),
    ),
  });
}
