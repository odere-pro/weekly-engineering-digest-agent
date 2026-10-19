import type { GuardsConfig } from '../../../config/schema';
import type { GuardCheckId } from '../../../guards/guardVerdict';
import { ok, warn, type CheckResult } from '../report/checkResult';

/**
 * The switchable guard checks, by section, in the order they run. A test fails when `GuardCheckId`
 * or the guard config gains a check these lists miss.
 */
export const INPUT_CHECKS = [
  'ruleInjection',
  'clefPolicy',
  'graniteRisk',
] as const satisfies readonly GuardCheckId[];
export const OUTPUT_CHECKS = [
  'graniteGroundedness',
  'clefRubric',
] as const satisfies readonly GuardCheckId[];

/** Warns, naming each switched-off check, because the digest footer says so too. */
export function checkGuards(guards: GuardsConfig): CheckResult {
  const label = 'guards';
  const off = [
    ...INPUT_CHECKS.filter((check) => !guards.input.enabled || !guards.input.checks[check]),
    ...OUTPUT_CHECKS.filter((check) => !guards.output.enabled || !guards.output.checks[check]),
  ];
  if (off.length === 0) return ok(label, 'all guards on');
  return warn(
    label,
    `off: ${off.join(', ')}; the digest footer will say so`,
    'turn them back on under "guards" in digest.config.json',
  );
}
