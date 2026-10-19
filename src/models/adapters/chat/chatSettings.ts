import type { Role } from '../../roles';

/** Ollama's `think` request field: on or off, or an effort level for models that have levels. */
export type ThinkSetting = boolean | 'low' | 'medium' | 'high';
export type ThinkByRole = Readonly<Partial<Record<Role, ThinkSetting>>>;
export type TemperatureByRole = Readonly<Partial<Record<Role, number>>>;

/**
 * Per-role `think` when `options.think` has none. granite4.1-guardian is a thinking model that
 * spends ~350 tokens (~65 s) on reasoning before a one-word `<score>`; the guards do not need it.
 */
export const DEFAULT_THINK: ThinkByRole = { guardRisk: false };
/**
 * Per-role sampling temperature when neither the request nor the config sets one (W7-03): a little
 * warmth for the writer, none for the roles that score, classify or guard.
 */
export const DEFAULT_TEMPERATURE: Readonly<Record<Role, number>> = {
  write: 0.2,
  classify: 0,
  guardPolicy: 0,
  guardRisk: 0,
  judge: 0,
};

/**
 * The `think` value generate sends for `role`: the configured one, else the adapter default, else
 * undefined (the field is left out and the model decides). The one place that rule lives, so
 * `digest doctor` shows what a run sends.
 */
export function effectiveThink(
  configured: ThinkByRole | undefined,
  role: Role,
): ThinkSetting | undefined {
  return configured?.[role] ?? DEFAULT_THINK[role];
}

/**
 * The temperature generate sends for `role`: the configured one, else the adapter default. A
 * request's own temperature wins over both. The one place that rule lives, so the run record shows
 * what a run sends.
 */
export function effectiveTemperature(
  configured: TemperatureByRole | undefined,
  role: Role,
): number {
  return configured?.[role] ?? DEFAULT_TEMPERATURE[role];
}
