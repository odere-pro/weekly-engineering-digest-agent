import type { GuardCheckId, GuardVerdict, Item } from '../schemas.js';
import type { InputGuard } from '../../ports/Guard.js';
import type { GuardMode, GuardsConfig } from '../../config/schema.js';
import type { Logger } from '../../shared/telemetry.js';

export interface GuardInputDeps {
  /** All available input guards; config decides which run. */
  guards: readonly InputGuard[];
  config: GuardsConfig['input'];
  logger: Logger;
}

export interface GuardInputOutput {
  kept: Item[];
  dropped: { item: Item; verdicts: GuardVerdict[] }[];
  /** Checks that were switched off (or missing) this run; named in the digest footer. */
  disabledChecks: GuardCheckId[];
}

/** Runs the input guards on every item (W1-06). */
export async function guardInputStep(
  items: readonly Item[],
  deps: GuardInputDeps,
): Promise<GuardInputOutput> {
  const { active, disabledChecks } = planGuards(deps.config, deps.guards, deps.logger);
  const checks = active.map((guard) => (item: Item) => guard.checkItem(item));
  const { kept, dropped } = await applyGuards(items, checks, deps.config.mode);
  for (const { subject, verdicts } of dropped) {
    deps.logger.debug('input guards dropped item', {
      itemId: subject.id,
      flaggedBy: flaggedBy(verdicts),
    });
  }
  return {
    kept,
    dropped: dropped.map(({ subject, verdicts }) => ({ item: subject, verdicts })),
    disabledChecks,
  };
}

// The helpers below are shared with guardOutput.ts, which has the same rules for drafts.

interface GuardSwitches<Check extends GuardCheckId> {
  enabled: boolean;
  checks: Readonly<Record<Check, boolean>>;
}

/** One guard, bound to the kind of subject it checks. */
export type GuardCheckFn<Subject> = (subject: Subject) => Promise<GuardVerdict>;

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
 * - any: a flag drops the subject at once, so the next guard only sees unflagged subjects.
 * - all: only flagged subjects go on to the next guard; a subject is dropped when the last
 *   guard flags it too.
 * Both lists keep input order. Guard errors propagate. No checks keeps every subject.
 */
export async function applyGuards<Subject>(
  subjects: readonly Subject[],
  checks: readonly GuardCheckFn<Subject>[],
  mode: GuardMode,
): Promise<GuardSplit<Subject>> {
  if (checks.length === 0) return { kept: [...subjects], dropped: [] };

  const continues = (verdict: GuardVerdict): boolean =>
    mode === 'any' ? !verdict.flagged : verdict.flagged;
  let survivors: Tracked<Subject>[] = subjects.map((subject, index) => ({
    index,
    subject,
    verdicts: [],
  }));
  let exited: Tracked<Subject>[] = [];
  for (const check of checks) {
    const examined = await examineAll(survivors, check);
    survivors = examined
      .filter((result) => continues(result.verdict))
      .map((result) => result.entry);
    exited = [
      ...exited,
      ...examined.filter((result) => !continues(result.verdict)).map((result) => result.entry),
    ];
  }

  const [keptEntries, droppedEntries] = mode === 'any' ? [survivors, exited] : [exited, survivors];
  return {
    kept: inInputOrder(keptEntries).map((entry) => entry.subject),
    dropped: inInputOrder(droppedEntries).map((entry) => ({
      subject: entry.subject,
      verdicts: [...entry.verdicts],
    })),
  };
}

/** One at a time: a single model never has to serve parallel requests. */
async function examineAll<Subject>(
  pool: readonly Tracked<Subject>[],
  check: GuardCheckFn<Subject>,
): Promise<{ entry: Tracked<Subject>; verdict: GuardVerdict }[]> {
  const results: { entry: Tracked<Subject>; verdict: GuardVerdict }[] = [];
  for (const entry of pool) {
    const verdict = await check(entry.subject);
    results.push({ entry: { ...entry, verdicts: [...entry.verdicts, verdict] }, verdict });
  }
  return results;
}

function inInputOrder<Subject>(entries: readonly Tracked<Subject>[]): Tracked<Subject>[] {
  return [...entries].sort((a, b) => a.index - b.index);
}

/** Ids of the checks that flagged, for logs; never the flagged text. */
export function flaggedBy(verdicts: readonly GuardVerdict[]): GuardCheckId[] {
  return verdicts.filter((verdict) => verdict.flagged).map((verdict) => verdict.check);
}
