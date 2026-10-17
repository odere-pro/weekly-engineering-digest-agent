import { z } from 'zod';
import {
  DigestItemSchema,
  DigestSchema,
  type DigestItem,
  type Draft,
  type ScoredItem,
} from '../schemas.js';
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

/**
 * The step replaces every item url with the source url, so a missing or malformed url from the
 * model is not worth a repair call.
 */
const WrittenItemSchema = DigestItemSchema.extend({ url: z.string().nullish() });
type WrittenItem = z.infer<typeof WrittenItemSchema>;

/** The model writes everything but the week; the step sets it. */
const DigestBodySchema = DigestSchema.omit({ weekId: true }).extend({
  items: z.array(WrittenItemSchema).min(1),
});

/** Words that add nothing next to a version: "Release v1.2.0", "Version 1.2.0". */
const RELEASE_FILLER: ReadonlySet<string> = new Set(['release', 'released', 'version', 'tag', 'v']);

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
    const kept = enforceProvenance(result.value.items, sources, logger).map(tidyTitle);
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
  drafted: readonly WrittenItem[],
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

function tidyTitle(item: DigestItem): DigestItem {
  return { ...item, title: collapseRestatedTag(item.title) };
}

/** Lowercase words of a title, with a sentence-ending dot and a version's "v" prefix removed. */
function comparableWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;:()[\]]+/)
    .map((word) => withoutTrailingDots(word).replace(/^v(?=\d)/, ''))
    .filter(Boolean);
}

/** A loop, not `/\.+$/`: that pattern is quadratic on a long run of dots inside model output. */
function withoutTrailingDots(word: string): string {
  let end = word.length;
  while (end > 0 && word[end - 1] === '.') end -= 1;
  return word.slice(0, end);
}

/**
 * "tool v1.2.0: Release v1.2.0" becomes "tool v1.2.0". A title tail after the first colon that
 * only repeats words from the head, plus filler like "Release", says nothing new.
 */
function collapseRestatedTag(title: string): string {
  const colon = title.indexOf(':');
  const head = colon > 0 ? title.slice(0, colon).trim() : '';
  const tail = colon > 0 ? title.slice(colon + 1).trim() : '';
  if (head === '' || tail === '') return title;
  const known = new Set(comparableWords(head));
  const isNew = (word: string): boolean => !known.has(word) && !RELEASE_FILLER.has(word);
  return comparableWords(tail).some(isNew) ? title : head;
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
