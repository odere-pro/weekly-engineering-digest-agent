import type { Item, Source } from '../../../domain/schemas';
import { errorMessage } from '../../../shared/errors';
import { withTimeout } from '../../../shared/retry';
import { truncate } from '../../../shared/text';
import type { FetchWindow } from '../../../sources/SourceFetcher';
import type { FetchRun, SourceReport } from './types';

/** What summary.json keeps of an error text, as the run record does. */
const MAX_ERROR_CHARS = 300;
/**
 * Control and format characters (escape codes, bidi overrides) have no place in a table. A local
 * copy: other commands keep their own, and a shared helper is not decided yet.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;

type Outcome = { ok: true; items: Item[] } | { ok: false; error: unknown };

/** Once, with the run's time limit and no retries: what the source does the first time. */
export async function fetchSource(source: Source, run: FetchRun): Promise<SourceReport> {
  const startedMs = run.clock.now().getTime();
  const window: FetchWindow = {
    ...run.window,
    maxItems: source.maxItems ?? run.maxItemsPerSource,
  };
  let outcome: Outcome;
  try {
    const items = await withTimeout(
      (signal) => run.fetchers[source.kind].fetch(source, window, signal),
      run.timeoutMs,
    );
    outcome = { ok: true, items };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const durationMs = run.clock.now().getTime() - startedMs;
  return reportOf(source, outcome, durationMs, run);
}

function reportOf(
  source: Source,
  outcome: Outcome,
  durationMs: number,
  run: FetchRun,
): SourceReport {
  const last = run.recorder.answers(source.id).at(-1);
  return {
    source,
    ok: outcome.ok,
    items: outcome.ok ? outcome.items : [],
    httpStatus: last?.status,
    answeredBy: last?.url,
    entries: run.recorder.entries(source.id),
    durationMs,
    error: outcome.ok ? undefined : errorText(outcome.error, run.redact),
  };
}

/** One line, free of control characters, without secrets (removed before any cut). */
export function errorText(error: unknown, redact: (text: string) => string): string {
  const line = redact(errorMessage(error)).replace(/\s+/g, ' ').replace(UNPRINTABLE, '').trim();
  return truncate(line, MAX_ERROR_CHARS);
}
