import type { GuardCheckId } from '../../../src/guards/guardVerdict';
import { caseEntries, measured, type Measurement } from '../measurement/measurement';

export interface GuardTally {
  checked: number;
  flagged: number;
  /** Ids of the clean cases the guard flagged; the scorecard names them. */
  flaggedCases?: readonly string[];
}

/**
 * Clean subjects a guard flagged. The value is the worst guard's rate; detail has each one's rate,
 * then names the clean cases it flagged when the tallies say which.
 */
export function guardFalseBlocks(
  tallies: Readonly<Partial<Record<GuardCheckId, GuardTally>>>,
): Measurement {
  const checked = Object.entries(tallies).filter(([, tally]) => tally.checked > 0);
  const rates = checked.map(([guard, tally]) => [guard, tally.flagged / tally.checked] as const);
  const named = checked.flatMap(([guard, tally]) =>
    caseEntries(`flagged:${guard}`, tally.flaggedCases ?? []),
  );
  return measured(
    rates.length === 0 ? null : Math.max(...rates.map(([, r]) => r)),
    Object.fromEntries([...rates, ...named]),
  );
}
