import { z } from 'zod';
import {
  DigestItemSchema,
  DigestSchema,
  type DigestItem,
  type Draft,
  type GuardCheckId,
  type Item,
  type ScoredItem,
} from '../schemas.js';
import { DIGEST_MIN_ITEMS, formatCheck } from '../checks/formatCheck.js';
import { linkCheck } from '../checks/linkCheck.js';
import {
  boundProblems,
  buildRetryPrompt,
  buildWritePrompt,
  type WritePrompt,
} from '../prompts/write.js';
import { renderDigest } from '../render.js';
import { generateStructured } from '../structured.js';
import type { ModelProvider } from '../../ports/ModelProvider.js';
import { errorMessage } from '../../shared/errors.js';
import type { Logger } from '../../shared/telemetry.js';
import { truncate } from '../../shared/text.js';
import { normalizeUrl } from '../../shared/url.js';

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

/** A writer whose draft the link or format check rejected, and why. */
export interface RetryRequest {
  writer: string;
  /** The check's problems; they quote model text, so the prompt wraps them as untrusted data. */
  problems: readonly string[];
}

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
 * Feed titles carry em dashes the format check rejects. A run of them, with the spaces and
 * commas around it, becomes one comma; at either end of a field it is dropped.
 */
const EM_DASH_RUN = /[\s,]*\u2014[\s,\u2014]*/g;
const EM_DASH_REPLACEMENT = ', ';

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
  return summarize(outcomes);
}

/**
 * One more try for the writers named in `requests` (W5-06, F1): the same items, plus the problems
 * the link or format check found in their draft. The caller decides who retries and when; a
 * failed retry is a failure for that writer, like a failed first attempt.
 */
export async function retryStep(
  items: readonly ScoredItem[],
  requests: readonly RetryRequest[],
  deps: WriteDeps,
): Promise<WriteOutput> {
  const sources = new Map(items.map((item) => [item.id, item]));
  const retryDeps = { ...deps, logger: deps.logger.child({ retry: true }) };
  const outcomes: WriterOutcome[] = [];
  for (const { writer, problems } of requests) {
    const prompt = buildRetryPrompt(items, deps.focusAreas, problems);
    outcomes.push(await draftWith(writer, prompt, sources, retryDeps));
  }
  return summarize(outcomes);
}

function summarize(outcomes: readonly WriterOutcome[]): WriteOutput {
  return {
    drafts: outcomes.flatMap((outcome) => ('draft' in outcome ? [outcome.draft] : [])),
    failures: outcomes.flatMap((outcome) => ('failure' in outcome ? [outcome.failure] : [])),
  };
}

/**
 * A link a browser or renderer would still follow, but without `https://`: `www.host/path` or
 * protocol-relative `//host/path`. It starts a match only at the start of the text or after
 * whitespace or an opening or emphasis character, so the `//` or `www.` inside `https://www.host`,
 * or in the path or query of any url (`?u=//host`), never does.
 */
const SCHEME_LESS_LINK = /(?<=^|[\s([{<>"'*_~])(?:www\.|\/\/(?=[^\s/]))[^\s<>"'`\]]+/gi;
/** What can end a sentence or close a Markdown link without being part of the url. */
const LINK_TRAILING = /[)\]}.,;:!?*_~]$/;
/** A collected url is far shorter; a longer token is not worth a lookup. */
export const MAX_LINK_CHARS = 2048;
/** Closing characters tried off the end of a token, so the work per token is bounded. */
export const MAX_TRAILING_CHARS = 8;

interface PreparedDraft {
  readonly draft: Draft;
  /** How many links got their `https://`. */
  readonly repairedLinks: number;
}

/**
 * Deterministic fixes the writers keep needing: at most topN items (defense in depth), no em
 * dashes, and `https://` on a link that names a collected item without it (W5-11).
 */
export function prepareDraft(draft: Draft, topN: number, collectedUrls: readonly string[]): Draft {
  return prepare(draft, topN, collectedUrls).draft;
}

function prepare(draft: Draft, topN: number, collectedUrls: readonly string[]): PreparedDraft {
  const { digest } = draft;
  const known = new Map(collectedUrls.map((url) => [normalizeUrl(url), url]));
  let repairedLinks = 0;
  const tidy = (text: string): string =>
    withSchemes(withoutEmDashes(text), known, () => {
      repairedLinks += 1;
    });
  const items = digest.items.slice(0, topN).map((item): DigestItem => ({
    ...item,
    title: tidy(item.title),
    area: tidy(item.area),
    summary: tidy(item.summary),
    whyItMatters: tidy(item.whyItMatters),
  }));
  const headline = tidy(digest.headline);
  const prepared = { ...draft, digest: { ...digest, headline, intro: tidy(digest.intro), items } };
  return { draft: prepared, repairedLinks };
}

/**
 * Adds the scheme to each scheme-less link in `text` that is, once `https://` is in front and
 * both sides are normalised the way the link check does, exactly a collected url. The collected
 * url as written replaces it, so the draft can only gain urls the link check accepts. Any other
 * link stays as it is, and the link check rejects it. `onRepair` is called once per link fixed.
 */
function withSchemes(
  text: string,
  known: ReadonlyMap<string, string>,
  onRepair: () => void,
): string {
  if (known.size === 0) return text;
  return text.replace(SCHEME_LESS_LINK, (token) => {
    const fixed = collectedUrlFor(token, known);
    if (fixed !== token) onRepair();
    return fixed;
  });
}

/** The collected url the token names, followed by what was trimmed off its end; else the token. */
function collectedUrlFor(token: string, known: ReadonlyMap<string, string>): string {
  if (token.length > MAX_LINK_CHARS) return token;
  let end = token.length;
  for (let trimmed = 0; trimmed <= MAX_TRAILING_CHARS; trimmed += 1) {
    const link = token.slice(0, end);
    const url = known.get(
      normalizeUrl(link.startsWith('//') ? `https:${link}` : `https://${link}`),
    );
    if (url !== undefined) return url + token.slice(end);
    if (!LINK_TRAILING.test(link)) break;
    end -= 1;
  }
  return token;
}

function withoutEmDashes(text: string): string {
  return text.replace(EM_DASH_RUN, (run: string, offset: number) =>
    offset === 0 || offset + run.length === text.length ? '' : EM_DASH_REPLACEMENT,
  );
}

// ---------------------------------------------------------------------------------------------
// Writing with the link and format checks, and one retry (W5-06: F1, F6)

/** A draft with the exact Markdown that was checked. */
export interface CheckedDraft {
  readonly draft: Draft;
  readonly markdown: string;
}

/** A draft with what the link and format checks said; `rejectedBy` is empty when it passed. */
export interface CodeChecked extends CheckedDraft {
  readonly rejectedBy: readonly string[];
  /**
   * Format problems first, then link problems: the retry prompt, the log and drafts.json keep
   * only the first few, and a draft with many bad links must not hide a word-count problem.
   * Whole here; each consumer bounds them.
   */
  readonly problems: readonly string[];
}

/** One draft the link or format check rejected, as drafts.json keeps it. */
export interface Rejection {
  readonly writer: string;
  /** 1 for the writer's first draft, 2 for its retry. */
  readonly attempt: 1 | 2;
  readonly rejectedBy: readonly string[];
  /** Bounded: the first few, each cut short. They can quote model text. */
  readonly problems: readonly string[];
}

export interface CheckedWriteDeps extends WriteDeps {
  /** Every collected item: the link check accepts only their URLs. */
  collected: readonly Item[];
  /** The guards that are off this run; the rendered footer names them. */
  disabledGuards: readonly GuardCheckId[];
  /** A draft keeps at most this many items. */
  topN: number;
}

export interface CheckedWriteOutput {
  /** One entry per writer that has a draft: its retry when that exists, else its first draft. */
  checked: CodeChecked[];
  /** Writers that produced no draft. */
  writeFailures: WriterFailure[];
  /** Writers whose retry produced no draft; their first draft stays in `checked`. */
  retryFailures: WriterFailure[];
  /** Every draft the checks rejected, first attempts then retries; logged at warn too. */
  rejections: Rejection[];
}

/**
 * Every writer drafts, each draft gets the deterministic fixes, then the link and format check.
 * When no draft passes, each writer that has a draft gets one retry with the problems its draft
 * had (F1). The retry is not repeated, and a writer that produced no draft is not retried.
 * Writers are unique (the config schema says so), so a retry replaces its writer's first draft.
 */
export async function writeCheckedStep(
  items: readonly ScoredItem[],
  deps: CheckedWriteDeps,
): Promise<CheckedWriteOutput> {
  const collectedUrls = deps.collected.map((item) => item.url);
  const check = (draft: Draft): CodeChecked => {
    const { draft: prepared, repairedLinks } = prepare(draft, deps.topN, collectedUrls);
    if (repairedLinks > 0) {
      deps.logger.info('Added https:// to links the writer left bare', {
        writer: draft.writer,
        links: repairedLinks,
      });
    }
    return codeCheck(prepared, deps.collected, deps.disabledGuards);
  };
  const first = await writeStep(items, deps);
  const checked = first.drafts.map(check);
  const rejections = noteRejections(deps.logger, checked, 1);
  const output = { checked, writeFailures: first.failures, retryFailures: [], rejections };
  if (checked.length === 0 || rejections.length < checked.length) return output;

  const requests = checked.map(({ draft, problems }) => ({ writer: draft.writer, problems }));
  deps.logger.info('Retrying writers after the checks', {
    writers: requests.map((request) => request.writer),
  });
  // Last writer first: its model is still loaded, and only one model fits in memory at a time.
  const retried = await retryStep(items, requests.toReversed(), deps);
  const again = new Map(retried.drafts.map(check).map((entry) => [entry.draft.writer, entry]));
  const final = checked.map((entry) => again.get(entry.draft.writer) ?? entry);
  const second = final.filter((entry) => again.get(entry.draft.writer) === entry);
  return {
    ...output,
    checked: final,
    retryFailures: retried.failures,
    rejections: [...rejections, ...noteRejections(deps.logger, second, 2)],
  };
}

/** Logs, at warn, each draft the checks rejected, and returns them for drafts.json. */
function noteRejections(
  logger: Logger,
  checked: readonly CodeChecked[],
  attempt: Rejection['attempt'],
): Rejection[] {
  const rejections = checked
    .filter((entry) => entry.rejectedBy.length > 0)
    .map(({ draft, rejectedBy, problems }): Rejection => ({
      writer: draft.writer,
      attempt,
      rejectedBy,
      problems: boundProblems(problems),
    }));
  for (const rejection of rejections) logger.warn('Draft failed the checks', { ...rejection });
  return rejections;
}

/** Renders the draft as the digest will read, and runs the link and format checks on that text. */
function codeCheck(
  draft: Draft,
  collected: readonly Item[],
  disabledGuards: readonly GuardCheckId[],
): CodeChecked {
  const markdown = renderDigest(draft.digest, { disabledGuards });
  const link = linkCheck(draft.digest, markdown, collected);
  const format = formatCheck(draft.digest, markdown);
  return {
    draft,
    markdown,
    rejectedBy: [...(link.ok ? [] : ['linkCheck']), ...(format.ok ? [] : ['formatCheck'])],
    problems: [...format.problems, ...link.problems],
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
