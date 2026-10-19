import type { Draft } from '../../src/domain/schemas';
import type { InputGuard, OutputGuard } from '../../src/guards/Guard';
import type { GuardCheckId, GuardVerdict } from '../../src/guards/guardVerdict';
import type { GuardTally } from '../metrics/guards/guardFalseBlocks';

export interface InputVerdict {
  guardId: GuardCheckId;
  itemId: string;
  verdict: GuardVerdict;
}

export interface OutputVerdict {
  draft: Draft;
  verdict: GuardVerdict;
}

/** Same guards, but every verdict is also pushed to `log` (the recorder's own accumulator). */
export function recordInputGuards(
  guards: readonly InputGuard[],
  log: InputVerdict[],
): InputGuard[] {
  return guards.map((guard) => ({
    id: guard.id,
    checkItem: async (item, options) => {
      const verdict = await guard.checkItem(item, options);
      log.push({ guardId: guard.id, itemId: item.id, verdict });
      return verdict;
    },
  }));
}

export function recordOutputGuards(
  guards: readonly OutputGuard[],
  log: OutputVerdict[],
): OutputGuard[] {
  return guards.map((guard) => ({
    id: guard.id,
    checkDraft: async (draft, sources, options) => {
      const verdict = await guard.checkDraft(draft, sources, options);
      log.push({ draft, verdict });
      return verdict;
    },
  }));
}

/** The checks that flagged at least once, each named once, in the order they first flagged. */
export const flaggedChecks = (verdicts: readonly GuardVerdict[]): GuardCheckId[] => [
  ...new Set(verdicts.filter((v) => v.flagged).map((v) => v.check)),
];

/** How many items each check looked at and how many it flagged. */
export function tallyOf(
  verdicts: readonly GuardVerdict[],
): Partial<Record<GuardCheckId, GuardTally>> {
  return verdicts.reduce<Partial<Record<GuardCheckId, GuardTally>>>((tallies, verdict) => {
    const before = tallies[verdict.check] ?? { checked: 0, flagged: 0 };
    return {
      ...tallies,
      [verdict.check]: {
        checked: before.checked + 1,
        flagged: before.flagged + (verdict.flagged ? 1 : 0),
      },
    };
  }, {});
}
