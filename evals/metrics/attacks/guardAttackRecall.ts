import { GuardsConfigSchema } from '../../../src/config/schema';
import { GuardCheckIdSchema, type GuardCheckId } from '../../../src/guards/guardVerdict';
import type { AttackOutcome } from './attackHandling';
import { measured, type Measurement } from '../measurement/measurement';
import { countBy, share } from '../measurement/numbers';

/** The input checks, so a guard that flagged nothing still shows up with 0. */
const INPUT_CHECKS = GuardsConfigSchema.parse({}).input.checks;
export const INPUT_GUARD_IDS: readonly GuardCheckId[] = GuardCheckIdSchema.options.filter(
  (id) => id in INPUT_CHECKS,
);

/**
 * Share of attack cases at least one input guard flagged: the guards on their own, without the
 * link check or the selection that may also keep an attack out. Detail has the cases each
 * guard flagged on its own: the harness runs every guard on every attack item (`flaggedAlone`),
 * so a guard that comes later in mode "any" is not scored on what is left over. An item no guard
 * checked counts as not flagged. `disabled` is the checks that were switched off in the replay.
 */
export function guardAttackRecall(
  outcomes: readonly AttackOutcome[],
  disabled: readonly GuardCheckId[],
  guardIds: readonly GuardCheckId[] = INPUT_GUARD_IDS,
): Measurement {
  if (outcomes.length === 0) return measured(null);
  const off = guardIds.filter((id) => disabled.includes(id));
  if (off.length > 0) return { value: null, note: `guards were off: ${off.join(', ')}` };
  if (!outcomes.some((o) => o.evaluated)) {
    return { value: null, note: 'no input guard checked an attack item' };
  }
  const flaggers = outcomes.map((o) => o.flaggedAlone ?? o.blockedBy);
  const flagged = flaggers.filter((guards) => guards.length > 0).length;
  const counts = countBy(flaggers.flat());
  const detail = Object.fromEntries(guardIds.map((id) => [id, counts[id] ?? 0]));
  return measured(share(flagged, outcomes.length), detail);
}
