import { z } from 'zod';
import {
  ClassificationSchema,
  type Classification,
  type Item,
  type ScoredItem,
  type Source,
} from '../schemas.js';
import type { DecisionAnswer, ModelProvider } from '../../ports/ModelProvider.js';
import { generateStructured } from '../structured.js';
import {
  OTHER_AREA,
  QUESTION_IDS,
  areaOptions,
  classifyBatchPrompt,
  classifyBatchSystem,
  classifyQuestions,
  classifyState,
  rescorePrompt,
  rescoreSystem,
} from '../prompts/classify.js';
import { DigestError, errorMessage } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';

export interface ClassifyDeps {
  model: ModelProvider;
  focusAreas: readonly string[];
  logger: Logger;
  /** decide: one decision call per item (default). generate: JSON batches of 10 (fallback). */
  mode?: 'decide' | 'generate';
  /** Source id to area tag. A source without an entry gets the same prompt as before. */
  areaHints?: ReadonlyMap<string, string>;
  /**
   * Score the items that pass `minRelevance` once more with the writer model (W6-08). Off by
   * default; call sites pass `config.models.rescoreWithWriter`.
   */
  rescoreWithWriter?: boolean;
  /** The relevance floor of the process step; required when `rescoreWithWriter` is on. */
  minRelevance?: number;
}

/** Builds `areaHints` from the configured sources; sources without an `area` are skipped. */
export function areaHintsOf(sources: readonly Source[]): ReadonlyMap<string, string> {
  return new Map(
    sources.flatMap((source): [string, string][] =>
      source.area === undefined ? [] : [[source.id, source.area]],
    ),
  );
}

/** Spec: score 10 items per call when the classifier generates JSON. */
const BATCH_SIZE = 10;
const MAX_RELEVANCE = 3;
/** A generated tag carries no probability, so the chosen area counts as certain. */
const GENERATED_AREA_CONFIDENCE = 1;
/** Classification answers are short tags; keep them deterministic. */
const GENERATE_TEMPERATURE = 0;

type AnswerOf<T extends DecisionAnswer['type']> = Extract<DecisionAnswer, { type: T }>;

/**
 * Scores relevance, area, hype and minor release for every item (W1-07). Returns the items in
 * input order; thresholds are applied later by the process step.
 */
export async function classifyStep(
  items: readonly Item[],
  deps: ClassifyDeps,
): Promise<ScoredItem[]> {
  if (items.length === 0) return [];
  if (deps.rescoreWithWriter && deps.minRelevance === undefined)
    throw classifyError('rescoreWithWriter needs minRelevance (config.thresholds.minRelevance)');
  const mode = deps.mode ?? 'decide';
  const decided =
    mode === 'generate' ? await classifyInBatches(items, deps) : await classifyEach(items, deps);
  const scored = deps.rescoreWithWriter ? await rescoreFiltered(decided, deps) : decided;
  deps.logger.info('Classified items', { mode, count: items.length });
  return scored;
}

/** Decide mode: one decision call per item, one at a time (the endpoint takes one state). */
async function classifyEach(items: readonly Item[], deps: ClassifyDeps): Promise<ScoredItem[]> {
  const questions = classifyQuestions(deps.focusAreas);
  const areas = new Set(areaOptions(deps.focusAreas));
  const scored: ScoredItem[] = [];
  for (const item of items) {
    const { answers } = await deps.model.decide({
      role: 'classify',
      state: classifyState(item, deps.areaHints?.get(item.sourceId)),
      questions,
    });
    scored.push({ ...item, classification: fromAnswers(item.id, answers, areas) });
  }
  return scored;
}

function fromAnswers(
  itemId: string,
  answers: Readonly<Record<string, DecisionAnswer>>,
  areas: ReadonlySet<string>,
): Classification {
  const relevance = answerOf(answers, QUESTION_IDS.relevance, 'score', itemId);
  const area = answerOf(answers, QUESTION_IDS.area, 'choice', itemId);
  const hype = answerOf(answers, QUESTION_IDS.hype, 'yesno', itemId);
  const minorRelease = answerOf(answers, QUESTION_IDS.minorRelease, 'yesno', itemId);
  if (!areas.has(area.choice))
    throw classifyError(`chose area "${area.choice}" for item ${itemId}, which is not an option`);
  return validated({
    itemId,
    relevance: relevance.level,
    area: area.choice,
    areaConfidence: area.confidence,
    hype: hype.probability,
    minorRelease: minorRelease.probability,
  });
}

function answerOf<T extends DecisionAnswer['type']>(
  answers: Readonly<Record<string, DecisionAnswer>>,
  questionId: string,
  type: T,
  itemId: string,
): AnswerOf<T> {
  const answer = answers[questionId];
  if (answer?.type !== type)
    throw classifyError(
      `expected a ${type} answer to "${questionId}" for item ${itemId}, got ${answer?.type ?? 'none'}`,
    );
  return answer as AnswerOf<T>;
}

function validated(classification: Classification): Classification {
  const parsed = ClassificationSchema.safeParse(classification);
  if (parsed.success) return parsed.data;
  throw classifyError(
    `invalid answers for item ${classification.itemId}: ${z.prettifyError(parsed.error)}`,
  );
}

function classifyError(message: string): DigestError {
  return new DigestError(`classify: ${message}`, { step: 'classify' });
}

/**
 * Generate mode: JSON batches of 10. Items the model leaves out are retried once together in
 * their own batches; items still missing default to not relevant.
 */
async function classifyInBatches(
  items: readonly Item[],
  deps: ClassifyDeps,
): Promise<ScoredItem[]> {
  const first = await scoreBatches(items, deps);
  const missing = items.filter((item) => !first.has(item.id));
  const retried =
    missing.length > 0 ? await scoreBatches(missing, deps) : new Map<string, Classification>();
  const scored = new Map([...first, ...retried]);
  const defaulted = items.filter((item) => !scored.has(item.id)).map((item) => item.id);
  if (defaulted.length > 0)
    deps.logger.warn('Classifier answer missing after a retry; item marked not relevant', {
      itemIds: defaulted,
    });
  return items.map((item) => ({
    ...item,
    classification: scored.get(item.id) ?? notRelevant(item.id),
  }));
}

/** Scores `items` in batches, one call at a time. The first answer for an id wins. */
async function scoreBatches(
  items: readonly Item[],
  deps: ClassifyDeps,
): Promise<Map<string, Classification>> {
  const scored = new Map<string, Classification>();
  for (const batch of chunk(items, BATCH_SIZE)) {
    for (const classification of await scoreBatch(batch, deps))
      if (!scored.has(classification.itemId)) scored.set(classification.itemId, classification);
  }
  return scored;
}

async function scoreBatch(batch: readonly Item[], deps: ClassifyDeps): Promise<Classification[]> {
  const schema = batchSchema(
    batch.map((item) => item.id),
    areaOptions(deps.focusAreas),
  );
  const { value, repaired } = await generateStructured(
    deps.model,
    {
      role: 'classify',
      system: classifyBatchSystem(deps.focusAreas),
      prompt: classifyBatchPrompt(batch, deps.areaHints),
      temperature: GENERATE_TEMPERATURE,
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
function batchSchema(ids: readonly string[], areas: readonly string[]) {
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

function notRelevant(itemId: string): Classification {
  return {
    itemId,
    relevance: 0,
    area: OTHER_AREA,
    areaConfidence: 0,
    hype: 0,
    minorRelease: 0,
  };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

// --- Rescoring with the writer model (W6-08) --------------------------------------------------

interface Rescore {
  relevance: number;
  area: string;
  /** Present only when the writer was highly confident in the area. */
  confidentArea: boolean;
}

/**
 * Sends the items that passed `minRelevance` to the writer model in batches. A batch that fails
 * keeps the decider's scores for its items.
 */
async function rescoreFiltered(
  scored: readonly ScoredItem[],
  deps: ClassifyDeps,
): Promise<ScoredItem[]> {
  const minRelevance = deps.minRelevance ?? Number.POSITIVE_INFINITY;
  const passed = scored.filter((item) => item.classification.relevance >= minRelevance);
  const rescored = new Map<string, Rescore>();
  for (const batch of chunk(passed, BATCH_SIZE)) {
    for (const [itemId, rescore] of await rescoreBatch(batch, deps)) rescored.set(itemId, rescore);
  }
  deps.logger.info('Rescored items with the writer model', {
    sent: passed.length,
    rescored: rescored.size,
  });
  return scored.map((item) => withRescore(item, rescored.get(item.id)));
}

/** Hype and minor-release stay the decider's; the writer sets relevance, and area when sure. */
function withRescore(item: ScoredItem, rescore: Rescore | undefined): ScoredItem {
  if (rescore === undefined) return item;
  const { classification } = item;
  return {
    ...item,
    classification: {
      ...classification,
      relevance: rescore.relevance,
      ...(rescore.confidentArea
        ? { area: rescore.area, areaConfidence: GENERATED_AREA_CONFIDENCE }
        : {}),
    },
  };
}

async function rescoreBatch(
  batch: readonly ScoredItem[],
  deps: ClassifyDeps,
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

function rescoreSchema(ids: readonly string[], areas: readonly string[]) {
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
