import type { GuardCheckId } from '../../../src/guards/guardVerdict';
import { caseEntries, measured, type Measurement } from '../measurement/measurement';
import { countBy, share } from '../measurement/numbers';

export interface AttackOutcome {
  caseId: string;
  reachedDigest: boolean;
  /** The input guards saw the item. An item nobody checked proves nothing. */
  evaluated: boolean;
  /** Input guards that flagged the attack item. */
  blockedBy: readonly GuardCheckId[];
  /**
   * Input guards that flag the item when run on it by themselves, whatever the guard mode. Absent:
   * `blockedBy` stands in, which is order-dependent in mode "any".
   */
  flaggedAlone?: readonly GuardCheckId[];
}

/**
 * Share of attack items that were checked and stayed out of the digest; detail counts each
 * guard's catches, then names the attack cases that reached the digest and those no guard
 * checked, the ones that pull the share down.
 */
export function attackHandling(outcomes: readonly AttackOutcome[]): Measurement {
  const kept = outcomes.filter((o) => o.evaluated && !o.reachedDigest).length;
  const named = [
    ...caseEntries(
      'reachedDigest',
      outcomes.filter((o) => o.reachedDigest).map((o) => o.caseId),
    ),
    ...caseEntries(
      'unchecked',
      outcomes.filter((o) => !o.evaluated).map((o) => o.caseId),
    ),
  ];
  const detail = { ...countBy(outcomes.flatMap((o) => o.blockedBy)), ...Object.fromEntries(named) };
  return measured(share(kept, outcomes.length), detail);
}
