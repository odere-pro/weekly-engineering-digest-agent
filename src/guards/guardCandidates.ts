import type { Item } from '../domain/schemas';
import type { Clock } from '../shared/clock';
import { noopLogger } from '../shared/telemetry';
import { DigestError } from '../shared/errors';
import type { InputGuard } from './Guard';
import type { GuardInputDeps } from './guardInput';
import { applyGuards, flaggedBy, passProgress } from './guardRun';
import { checkWith, planInputGuards } from './inputGuardPlan';
import type { GuardVerdict } from './guardVerdict';

/** What the digest would take now, given the items the guards flagged so far. */
interface CandidatePicks<T extends Item> {
  /** The items the digest takes, in rank order. */
  picks: readonly T[];
  /** The other eligible items, best first: checked ahead of need once a pick is flagged. */
  next: readonly T[];
}

/**
 * Picks the candidates without the flagged items. It must hand back the very item objects it was
 * built from: the step tells checked items by identity.
 */
export type PickCandidates<T extends Item> = (flagged: ReadonlySet<T>) => CandidatePicks<T>;

export interface GuardCandidatesDeps extends Pick<
  GuardInputDeps,
  'guards' | 'config' | 'logger' | 'concurrency' | 'signal'
> {
  /** Times the `Progress` lines; the system clock when absent. */
  clock?: Clock;
}

export interface GuardCandidatesOutput<T extends Item> {
  /** The final picks: every one passed the model guards. In rank order. */
  kept: T[];
  dropped: { item: T; verdicts: GuardVerdict[] }[];
  /** Items the model guards checked, over all batches. */
  checked: number;
  /** Batches the model guards ran. */
  rounds: number;
}

/** Tracks what the model guards have said so far. Sets of item objects, never ids. */
interface Verdicts<T extends Item> {
  cleared: ReadonlySet<T>;
  flagged: ReadonlySet<T>;
  dropped: { item: T; verdicts: GuardVerdict[] }[];
}

/**
 * The next batch: the picks not checked yet, topped up from `next` to the size of the picks, so a
 * flag costs one more batch for several replacements instead of one batch each. Empty when every
 * pick has passed.
 */
function nextBatch<T extends Item>({ picks, next }: CandidatePicks<T>, seen: Verdicts<T>): T[] {
  const unseen = (item: T): boolean => !seen.cleared.has(item) && !seen.flagged.has(item);
  const missing = picks.filter(unseen);
  if (missing.length === 0) return [];
  const spare = picks.length - missing.length;
  return [...missing, ...next.filter(unseen).slice(0, spare)];
}

/**
 * The model input guards over the ranked candidates (PERF-2), instead of over every collected item.
 * Each batch runs guard by guard, as `guardInputStep` does. A flagged item leaves the candidates,
 * `pick` is asked again, and the items it now takes are checked, until every pick has passed or no
 * item is left. The rule guard is not run here: `guardInputStep` already ran it on every item.
 */
export async function guardCandidatesStep<T extends Item>(
  pick: PickCandidates<T>,
  deps: GuardCandidatesDeps,
): Promise<GuardCandidatesOutput<T>> {
  // `guardInputStep` already planned these guards and warned about a missing one.
  const { models } = planInputGuards({ ...deps, logger: noopLogger });
  let candidates = pick(new Set());
  if (models.length === 0)
    return { kept: [...candidates.picks], dropped: [], checked: 0, rounds: 0 };
  const checkBatch = batchChecker(models, deps);
  // Each batch flags an item or ends the step, so it needs at most one batch per eligible item.
  const maxRounds = candidates.picks.length + candidates.next.length + 1;
  let seen: Verdicts<T> = { cleared: new Set(), flagged: new Set(), dropped: [] };
  let checked = 0;
  let rounds = 0;
  for (;;) {
    const batch = nextBatch(candidates, seen);
    if (batch.length === 0) {
      return { kept: [...candidates.picks], dropped: seen.dropped, checked, rounds };
    }
    if (rounds >= maxRounds) {
      throw new DigestError(
        'guardCandidates: pick handed back items it was not given, so checked items cannot be told apart',
      );
    }
    seen = await checkBatch(batch, seen);
    checked += batch.length;
    rounds += 1;
    candidates = pick(seen.flagged);
  }
}

/** The model guards over one batch, guard by guard; the verdicts join what was seen before. */
function batchChecker(
  models: readonly InputGuard[],
  deps: GuardCandidatesDeps,
): <T extends Item>(batch: T[], seen: Verdicts<T>) => Promise<Verdicts<T>> {
  const checks = models.map((guard) => checkWith(guard, deps.signal));
  const progress = passProgress(
    models.map((guard) => guard.id),
    deps.logger,
    deps.clock,
  );
  return async (batch, seen) => {
    const split = await applyGuards(
      batch,
      checks,
      deps.config.mode,
      deps.concurrency,
      [],
      progress,
    );
    const dropped = split.dropped.map(({ subject, verdicts }) => ({ item: subject, verdicts }));
    for (const { item, verdicts } of dropped) {
      deps.logger.debug('candidate guards dropped item', {
        itemId: item.id,
        flaggedBy: flaggedBy(verdicts),
      });
    }
    return {
      cleared: new Set([...seen.cleared, ...split.kept]),
      flagged: new Set([...seen.flagged, ...dropped.map(({ item }) => item)]),
      dropped: [...seen.dropped, ...dropped],
    };
  };
}
