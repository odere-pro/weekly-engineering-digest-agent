import { z } from 'zod';
import { GENERATED_AREA_CONFIDENCE, GENERATE_TEMPERATURE, MAX_RELEVANCE } from './limits';
import type { Classification } from '../classification';
import { areaOptions, classifyBatchPrompt, classifyBatchSystem } from '../classifyPrompt';
import type { ClassifierDeps } from '../types';
import type { Item } from '../../domain/schemas';
import { generateStructured } from '../../models/structured';

/**
 * Scores one batch with a single generate call. The reply must be JSON that names only items of
 * the batch and areas of the focus list; `generateStructured` repairs it once, then throws. A
 * fired `deps.signal` stops it before the call, and an aborted call rejects.
 */
export async function scoreBatch(
  batch: readonly Item[],
  deps: ClassifierDeps,
): Promise<Classification[]> {
  const schema = batchSchema(
    batch.map((item) => item.id),
    areaOptions(deps.focusAreas),
  );
  deps.signal?.throwIfAborted();
  const { value, repaired } = await generateStructured(
    deps.model,
    {
      role: 'classify',
      system: classifyBatchSystem(deps.focusAreas),
      prompt: classifyBatchPrompt(batch, deps.areaHints),
      temperature: GENERATE_TEMPERATURE,
      signal: deps.signal,
    },
    schema,
    'classify',
  );
  if (repaired)
    deps.logger.warn('Classifier batch output was repaired', {
      itemIds: batch.map((item) => item.id),
    });
  return value.items.map((answer) => ({
    itemId: answer.id,
    relevance: answer.relevance,
    area: answer.area,
    areaConfidence: GENERATED_AREA_CONFIDENCE,
    hype: answer.hype ? 1 : 0,
    minorRelease: answer.minorRelease ? 1 : 0,
  }));
}

/** Ids and areas are enums, so structured output can only name items and areas it was given. */
export function batchSchema(ids: readonly string[], areas: readonly string[]) {
  return z.object({
    items: z.array(
      z.object({
        id: z.enum(ids),
        relevance: z.number().int().min(0).max(MAX_RELEVANCE),
        area: z.enum(areas),
        hype: z.boolean(),
        minorRelease: z.boolean(),
      }),
    ),
  });
}
