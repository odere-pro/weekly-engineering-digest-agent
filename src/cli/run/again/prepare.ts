import type { LoadedConfig } from '../../../config/load';
import { DigestError, errorMessage } from '../../../shared/errors';
import { isoWeekId } from '../../../shared/isoWeek';
import type { Clock } from '../../../shared/clock';
import type { RunStore } from '../../../store/RunStore';
import { isPromptCancelled } from '../../init/io/inquirerPrompts';
import type { Reporter } from '../summary/summary';
import { askAgain, decideAgain } from './askAgain';
import { confirmSave, saveSources } from './saveSources';
import type { AgainOptions, FileIo, RunPrompts } from './types';
import { variantPlan, type VariantPlan } from './variant';

/** What a second run needs from outside; `runCommand` fills it from its deps. */
export interface AgainIo extends FileIo {
  prompts: RunPrompts;
  interactive: boolean;
  createStore: (dataDir: string) => RunStore;
  clock: Clock;
}

const CANCELLED = 'Cancelled. Nothing was run.';

/** True when a flag already names the variant. */
function hasFlag(options: AgainOptions): boolean {
  return (
    options.enrich === true ||
    options.complete === true ||
    options.perspective !== undefined ||
    (options.addSource?.length ?? 0) > 0
  );
}

/** Offers to keep the added sources in the config file; a terminal is asked, anything else gets a hint. */
async function offerSave(
  plan: VariantPlan,
  loaded: LoadedConfig,
  io: AgainIo,
  report: Reporter,
): Promise<void> {
  if (plan.added.length === 0) return;
  if (!io.interactive) {
    report.out(`Sources added for this run only. Add them to ${loaded.configPath} to keep them.\n`);
    return;
  }
  if (!(await confirmSave(io.prompts, loaded.configPath))) return;
  try {
    await saveSources(loaded.configPath, plan.added, loaded.config.sources, io);
  } catch (error) {
    report.err(`Warning: could not save the sources: ${errorMessage(error)}\n`);
  }
}

/**
 * Finds out whether this run is a second run of the week and, if so, which one. Returns the plan
 * (what to reuse, the variant, the config with any added sources) or `undefined` for a plain run:
 * no flag and no menu (not a terminal, `--force`, no sent or dry-run digest) or "Skip".
 * Ctrl+C in a question stops the run with a `DigestError`.
 */
export async function prepareAgain(
  options: AgainOptions,
  loaded: LoadedConfig,
  io: AgainIo,
  report: Reporter,
): Promise<VariantPlan | undefined> {
  if (!hasFlag(options) && (options.force === true || !io.interactive)) return undefined;
  const store = io.createStore(loaded.config.dataDir);
  const weekId = isoWeekId(io.clock.now(), loaded.config.schedule.timeZone);
  const previous = await store.getRunRecord(weekId);
  const decision = decideAgain({ options, interactive: io.interactive, previous });
  if (decision === undefined) return undefined;
  try {
    const choice = decision === 'ask' && previous ? await askAgain(io.prompts, previous) : decision;
    if (choice === 'skip' || choice === 'ask') return undefined;
    const plan = await variantPlan(choice, {
      previous,
      store,
      weekId,
      prompts: io.prompts,
      loaded,
      flags: options,
    });
    await offerSave(plan, loaded, io, report);
    return plan;
  } catch (error) {
    if (isPromptCancelled(error)) throw new DigestError(CANCELLED);
    throw error;
  }
}
