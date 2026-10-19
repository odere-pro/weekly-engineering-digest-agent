import type { Draft } from '../domain/schemas';
import type { ScoredItem } from '../classify/classification';
import { DIGEST_MIN_ITEMS } from '../checks/formatCheck';
import { buildRetryPrompt, buildWritePrompt, type WritePrompt } from './writePrompt';
import { DigestBodySchema } from './writerSchema';
import { checkDraft } from './checkedStep/checkDraft';
import { mergeRetries } from './checkedStep/mergeRetries';
import { noteRejections } from './checkedStep/noteRejections';
import type { CheckContext, CodeChecked, Rejection } from './checkedStep/types';
import { enforceProvenance } from './provenance/enforceProvenance';
import { raiseSecurityItems } from './provenance/securityFloor';
import { tidyTitle } from './tidy/title';
import { generateStructured } from '../models/structured';
import type { ModelProvider } from '../models/ModelProvider';
import { errorMessage } from '../shared/errors';
import type { Logger } from '../shared/telemetry';

// Compat (W10-B23): `digest` imports these from here. Remove when callers move to checkedStep/types.
export type { CheckedDraft, CodeChecked } from './checkedStep/types';

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

export interface CheckedWriteDeps extends WriteDeps, CheckContext {}

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
  const check = (draft: Draft): CodeChecked => checkDraft(draft, deps);
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
  const merged = mergeRetries(checked, retried.drafts.map(check));
  return {
    ...output,
    checked: merged.checked,
    retryFailures: retried.failures,
    rejections: [...rejections, ...noteRejections(deps.logger, merged.retried, 2)],
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
    const owned = enforceProvenance(result.value.items, sources, logger);
    const kept = raiseSecurityItems(owned, sources, logger).map(tidyTitle);
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

/** Keeps the validation detail that generateStructured puts in `cause`. */
function describeError(error: unknown): string {
  const message = errorMessage(error);
  return error instanceof Error && error.cause !== undefined
    ? `${message}: ${errorMessage(error.cause)}`
    : message;
}
