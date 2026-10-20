import type { GuardsConfig } from '../../src/config/schema';
import type { Item } from '../../src/domain/schemas';
import type { InputGuard } from '../../src/guards/Guard';
import { guardInputStep } from '../../src/guards/guardInput';
import type { Logger } from '../../src/shared/telemetry';
import type { InputVerdict } from './guardVerdicts';

/**
 * The run's input verdicts plus what each input guard says about every collected item it was not
 * shown. A run shows the model guards only the ranked candidates (PERF-2), but `guardFalseBlocks`
 * is measured on every item of a week, as before. It runs `guardInputStep` with every guard, in
 * the config's mode, so a later guard sees only what the earlier ones let through, as the chain
 * did before PERF-2. A verdict the run already got is reused, never asked again. The collected
 * items are the ones the run logged a verdict for (the rule guard checks each one).
 */
export async function sweepInputGuards(
  guards: readonly InputGuard[],
  items: readonly Item[],
  run: readonly InputVerdict[],
  deps: { config: GuardsConfig['input']; logger: Logger },
): Promise<InputVerdict[]> {
  const asked: InputVerdict[] = [];
  const known = (guardId: string, itemId: string): InputVerdict | undefined =>
    run.find((v) => v.guardId === guardId && v.itemId === itemId);
  const reusing = guards.map((guard): InputGuard => ({
    id: guard.id,
    checkItem: async (item, options) => {
      const seen = known(guard.id, item.id);
      if (seen) return seen.verdict;
      const verdict = await guard.checkItem(item, options);
      asked.push({ guardId: guard.id, itemId: item.id, verdict });
      return verdict;
    },
  }));
  const collected = new Set(run.map((v) => v.itemId));
  await guardInputStep(
    items.filter((item) => collected.has(item.id)),
    { guards: reusing, config: deps.config, logger: deps.logger },
  );
  return [...run, ...inGuardOrder(asked, guards)];
}

/** One guard's verdicts after another's, in the order the guards are listed. */
function inGuardOrder(
  asked: readonly InputVerdict[],
  guards: readonly InputGuard[],
): InputVerdict[] {
  return guards.flatMap((guard) => asked.filter((v) => v.guardId === guard.id));
}
