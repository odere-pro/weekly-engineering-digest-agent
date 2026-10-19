// The guard engine both guard steps share (W5-06, F36): which guards run, and how they run.
import type { GuardMode } from '../config/schema';
import type { Clock } from '../shared/clock';
import { DigestError } from '../shared/errors';
import { startProgress } from '../shared/progress';
import type { Logger } from '../shared/telemetry';
import type { GuardCheckId, GuardVerdict } from './guardVerdict';

/**
 * Most calls one guard has in flight at once (W5-16, F38). A guard still runs from first subject
 * to last before the next guard starts, so the extra calls all go to the same model and no second
 * model is loaded. 1 is the old behaviour: one call at a time.
 *
 * It stays 1 on purpose. Measured on the light profile (2026-10-17, one recorded week plus the
 * attack items, 116 guard calls): limits 1, 2 and 4 all took about 112 s with identical verdicts,
 * and a call took about as many times longer as the limit, so this Ollama setup served the calls one
 * at a time. Raise it only after timing a setup that runs requests in parallel (OLLAMA_NUM_PARALLEL,
 * a remote server): a call the server has queued still spends its per-attempt timeout
 * (models/ollama.ts) while it waits.
 */
export const GUARD_CONCURRENCY = 1;

interface GuardSwitches<Check extends GuardCheckId> {
  enabled: boolean;
  checks: Readonly<Record<Check, boolean>>;
}

/** One guard, bound to the kind of subject it checks. */
export type GuardCheckFn<Subject> = (subject: Subject) => Promise<GuardVerdict>;

/**
 * Called when a guard starts its pass over `size` subjects (`index` is the guard's place among the
 * checks); the function it returns is called once for each subject the guard has finished.
 */
export type PassProgress = (index: number, size: number) => () => void;

/** A `PassProgress` that logs through `startProgress`, one label per check, in check order. */
export function passProgress(
  labels: readonly string[],
  logger: Logger,
  clock?: Clock,
): PassProgress {
  return (index, size) => {
    const progress = startProgress({
      label: labels[index] ?? `guard ${index + 1}`,
      total: size,
      logger,
      clock,
    });
    return () => {
      progress.tick();
    };
  };
}

export interface GuardSplit<Subject> {
  kept: Subject[];
  dropped: { subject: Subject; verdicts: GuardVerdict[] }[];
}

/**
 * Decides which guards run, in config order (which is also the order the spec numbers them).
 * A check runs when the section and the check are on and a guard with its id was supplied. Every
 * other check is reported as disabled; a missing guard also logs a warning.
 */
export function planGuards<Check extends GuardCheckId, Guard extends { readonly id: GuardCheckId }>(
  config: GuardSwitches<Check>,
  guards: readonly Guard[],
  logger: Logger,
): { active: Guard[]; disabledChecks: Check[] } {
  const active: Guard[] = [];
  const disabledChecks: Check[] = [];
  for (const check of Object.keys(config.checks) as Check[]) {
    const guard = config.enabled && config.checks[check] ? findGuard(guards, check) : undefined;
    if (guard) {
      active.push(guard);
      continue;
    }
    if (config.enabled && config.checks[check]) {
      logger.warn(`guard for check ${check} is not available; the check is skipped`, { check });
    }
    disabledChecks.push(check);
  }
  return { active, disabledChecks };
}

function findGuard<Guard extends { readonly id: GuardCheckId }>(
  guards: readonly Guard[],
  check: GuardCheckId,
): Guard | undefined {
  return guards.find((guard) => guard.id === check);
}

interface Tracked<Subject> {
  index: number;
  subject: Subject;
  verdicts: readonly GuardVerdict[];
}

/**
 * Runs the checks guard by guard, never subject by subject, so only one model is loaded at a time.
 * - blocking: checks that behave like mode `any` whatever the mode is (the deterministic rule
 *   guard). They run first; a flag drops the subject for good.
 * - any: a flag drops the subject at once, so the next guard only sees unflagged subjects.
 * - all: only flagged subjects go on to the next guard; a subject is dropped when the last
 *   guard flags it too.
 * Within a guard, at most `concurrency` subjects are checked at once. Both lists keep input
 * order, whatever order the calls finish in. Guard errors propagate (see `mapBounded`). No
 * checks keeps every subject. `progress` hears of the main pass only, not the blocking one.
 */
export async function applyGuards<Subject>(
  subjects: readonly Subject[],
  checks: readonly GuardCheckFn<Subject>[],
  mode: GuardMode,
  concurrency: number = GUARD_CONCURRENCY,
  blocking: readonly GuardCheckFn<Subject>[] = [],
  progress?: PassProgress,
): Promise<GuardSplit<Subject>> {
  assertConcurrency(concurrency);

  const initial: Tracked<Subject>[] = subjects.map((subject, index) => ({
    index,
    subject,
    verdicts: [],
  }));
  const pre = await runPass(initial, blocking, 'any', concurrency);
  const main = await runPass(pre.survivors, checks, mode, concurrency, progress);
  const keptEntries = checks.length === 0 ? pre.survivors : main.kept;
  const droppedEntries = checks.length === 0 ? pre.exited : [...pre.exited, ...main.dropped];
  return {
    kept: inInputOrder(keptEntries).map((entry) => entry.subject),
    dropped: inInputOrder(droppedEntries).map((entry) => ({
      subject: entry.subject,
      verdicts: [...entry.verdicts],
    })),
  };
}

/** One pass over `checks` in `mode`. Survivors of an empty pass are all kept (mode `any` shape). */
async function runPass<Subject>(
  pool: readonly Tracked<Subject>[],
  checks: readonly GuardCheckFn<Subject>[],
  mode: GuardMode,
  concurrency: number,
  progress?: PassProgress,
): Promise<{
  survivors: Tracked<Subject>[];
  exited: Tracked<Subject>[];
  kept: Tracked<Subject>[];
  dropped: Tracked<Subject>[];
}> {
  const continues = (verdict: GuardVerdict): boolean =>
    mode === 'any' ? !verdict.flagged : verdict.flagged;
  let survivors = [...pool];
  let exited: Tracked<Subject>[] = [];
  for (const [index, check] of checks.entries()) {
    const tick = progress?.(index, survivors.length);
    const examined = await examineAll(survivors, check, concurrency, tick);
    survivors = examined
      .filter((result) => continues(result.verdict))
      .map((result) => result.entry);
    exited = [
      ...exited,
      ...examined.filter((result) => !continues(result.verdict)).map((result) => result.entry),
    ];
  }
  const [kept, dropped] = mode === 'any' ? [survivors, exited] : [exited, survivors];
  return { survivors, exited, kept, dropped };
}

function assertConcurrency(concurrency: number): void {
  if (Number.isInteger(concurrency) && concurrency >= 1) return;
  throw new DigestError(
    `guard concurrency must be a whole number of at least 1, got ${concurrency}`,
  );
}

/** One guard over a pool of subjects, results in pool order. */
async function examineAll<Subject>(
  pool: readonly Tracked<Subject>[],
  check: GuardCheckFn<Subject>,
  concurrency: number,
  tick?: () => void,
): Promise<{ entry: Tracked<Subject>; verdict: GuardVerdict }[]> {
  return mapBounded(pool, concurrency, async (entry) => {
    const verdict = await check(entry.subject);
    tick?.();
    return { entry: { ...entry, verdicts: [...entry.verdicts, verdict] }, verdict };
  });
}

/**
 * Maps `inputs` with at most `limit` calls of `fn` in flight, starting the next call as soon
 * as one finishes. The results are in input order. When a call fails, no further call starts;
 * the calls already in flight finish (a model call cannot be taken back, and the next step must
 * not find the model still busy), then the failure of the earliest input is thrown; failures of
 * later inputs are dropped on purpose, so the error does not depend on which call finished first.
 * With a limit of 1 that is the failing call itself, and no later call was ever made.
 *
 * The workers pull from one shared array iterator. That is safe because an array iterator has no
 * `return()`: a worker that leaves its loop early cannot close the queue for the others.
 */
async function mapBounded<In, Out>(
  inputs: readonly In[],
  limit: number,
  fn: (input: In) => Promise<Out>,
): Promise<Out[]> {
  const done: { index: number; value: Out }[] = [];
  const failed: { index: number; error: unknown }[] = [];
  const queue = inputs.entries();

  const worker = async (): Promise<void> => {
    for (const [index, input] of queue) {
      if (failed.length > 0) return;
      try {
        done.push({ index, value: await fn(input) });
      } catch (error) {
        failed.push({ index, error });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, () => worker()));

  const [earliest] = [...failed].sort((a, b) => a.index - b.index);
  if (earliest) throw earliest.error;
  return [...done].sort((a, b) => a.index - b.index).map(({ value }) => value);
}

function inInputOrder<Subject>(entries: readonly Tracked<Subject>[]): Tracked<Subject>[] {
  return [...entries].sort((a, b) => a.index - b.index);
}

/** Ids of the checks that flagged, for logs; never the flagged text. */
export function flaggedBy(verdicts: readonly GuardVerdict[]): GuardCheckId[] {
  return verdicts.filter((verdict) => verdict.flagged).map((verdict) => verdict.check);
}
