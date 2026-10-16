import { DigestSchema, type DigestItem, type Draft, type ScoredItem } from '../schemas.js';
import { buildWritePrompt, DIGEST_MIN_ITEMS, type WritePrompt } from '../prompts/write.js';
import { generateStructured } from '../structured.js';
import type { ModelProvider } from '../../ports/ModelProvider.js';
import { errorMessage } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';
import { truncate } from '../../shared/text.js';

export interface WriteDeps {
  model: ModelProvider;
  /** Writer model tags in config order; drafted one after another. */
  writers: readonly string[];
  focusAreas: readonly string[];
  weekId: string;
  logger: Logger;
}

export interface WriteOutput {
  drafts: Draft[];
  failures: { writer: string; error: string }[];
}

type WriterFailure = WriteOutput['failures'][number];
type WriterOutcome = { draft: Draft } | { failure: WriterFailure };

/** The model writes everything but the week; the step sets it. */
const DigestBodySchema = DigestSchema.omit({ weekId: true });

/** Item ids in logs come from model output; keep them short. */
const LOGGED_ID_MAX_CHARS = 80;

/**
 * Each writer drafts the digest from the same top items, one after another (W1-09).
 * A writer that fails is listed in `failures` and the next one still runs.
 */
export async function writeStep(
  items: readonly ScoredItem[],
  deps: WriteDeps,
): Promise<WriteOutput> {
  if (items.length < DIGEST_MIN_ITEMS) return tooFewItems(items.length, deps);
  const prompt = buildWritePrompt(items, deps.focusAreas);
  const sources = new Map(items.map((item) => [item.id, item]));
  const outcomes: WriterOutcome[] = [];
  // Sequential on purpose: one model in memory at a time (OLLAMA_MAX_LOADED_MODELS=1).
  for (const writer of deps.writers) {
    outcomes.push(await draftWith(writer, prompt, sources, deps));
  }
  return {
    drafts: outcomes.flatMap((outcome) => ('draft' in outcome ? [outcome.draft] : [])),
    failures: outcomes.flatMap((outcome) => ('failure' in outcome ? [outcome.failure] : [])),
  };
}

/** No writer can reach the minimum, so none is loaded. */
function tooFewItems(count: number, deps: WriteDeps): WriteOutput {
  const error = `Only ${count} input items; a digest needs at least ${DIGEST_MIN_ITEMS}`;
  deps.logger.warn('Skipped every writer', { step: 'write', error });
  return { drafts: [], failures: deps.writers.map((writer) => ({ writer, error })) };
}

/** Never rejects: every error becomes a failure for this writer. */
async function draftWith(
  writer: string,
  prompt: WritePrompt,
  sources: ReadonlyMap<string, ScoredItem>,
  deps: WriteDeps,
): Promise<WriterOutcome> {
  const logger = deps.logger.child({ step: 'write', writer });
  try {
    const result = await generateStructured(
      deps.model,
      { role: 'write', model: writer, ...prompt },
      DigestBodySchema,
      'write',
    );
    const kept = enforceProvenance(result.value.items, sources, logger);
    if (kept.length < DIGEST_MIN_ITEMS) {
      throw new Error(
        `Only ${kept.length} valid items after the provenance check; need at least ${DIGEST_MIN_ITEMS}`,
      );
    }
    logger.info('Writer drafted digest', { items: kept.length, repaired: result.repaired });
    return { draft: { writer, digest: { ...result.value, items: kept, weekId: deps.weekId } } };
  } catch (error) {
    const message = describeError(error);
    logger.warn('Writer failed', { error: message });
    return { failure: { writer, error: message } };
  }
}

/**
 * Keeps only items that point at a collected item, once each, with the source URL.
 * The model can name an item but never choose where its link goes.
 */
function enforceProvenance(
  drafted: readonly DigestItem[],
  sources: ReadonlyMap<string, ScoredItem>,
  logger: Logger,
): DigestItem[] {
  const seen = new Set<string>();
  return drafted.flatMap((item) => {
    const source = sources.get(item.itemId);
    if (!source) {
      logger.warn('Removed digest item with unknown itemId', { itemId: loggedId(item.itemId) });
      return [];
    }
    if (seen.has(item.itemId)) {
      logger.warn('Removed repeated digest item', { itemId: loggedId(item.itemId) });
      return [];
    }
    seen.add(item.itemId);
    return [{ ...item, url: source.url }];
  });
}

function loggedId(itemId: string): string {
  return truncate(itemId, LOGGED_ID_MAX_CHARS);
}

/** Keeps the validation detail that generateStructured puts in `cause`. */
function describeError(error: unknown): string {
  const message = errorMessage(error);
  return error instanceof Error && error.cause !== undefined
    ? `${message}: ${errorMessage(error.cause)}`
    : message;
}
