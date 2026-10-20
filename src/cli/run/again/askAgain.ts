import { DigestError } from '../../../shared/errors';
import type { RunRecord } from '../../../store/runRecord';
import type { AgainChoice, AgainDecision, AgainOptions, RunPrompts } from './types';

/** The variant flags that are set, as `[flag, kind]`. */
function chosenFlags(options: AgainOptions): [string, AgainDecision][] {
  const chosen: [string, AgainDecision][] = [];
  if (options.enrich === true) chosen.push(['--enrich', 'enrich']);
  if (options.complete === true) chosen.push(['--complete', 'complete']);
  if (options.perspective !== undefined) chosen.push(['--perspective', 'perspective']);
  if (options.addSource !== undefined && options.addSource.length > 0) {
    chosen.push(['--add-source', 'add-sources']);
  }
  return chosen;
}

/**
 * Flags win and exclude each other. Without one, the menu is for an interactive terminal, no
 * `--force`, and a week that already has a sent or dry-run digest; anything else runs as before.
 */
export function decideAgain(input: {
  options: AgainOptions;
  interactive: boolean;
  previous: RunRecord | undefined;
}): AgainDecision {
  const { options, interactive, previous } = input;
  const flags = chosenFlags(options);
  if (flags.length > 1) {
    const names = flags.map(([flag]) => flag).join(' and ');
    throw new DigestError(
      `Use only one of --enrich, --complete, --perspective, --add-source (got ${names}).`,
    );
  }
  if (flags[0]) return flags[0][1];
  if (options.force === true || !interactive || previous === undefined) return undefined;
  return previous.status === 'sent' || previous.status === 'dry-run' ? 'ask' : undefined;
}

/** The menu. Enter picks `skip`. */
export function askAgain(prompts: RunPrompts, previous: RunRecord): Promise<AgainChoice> {
  const kind = previous.status === 'sent' ? 'a sent digest' : 'a dry-run digest';
  return prompts.select<AgainChoice>({
    message: `Week ${previous.runId} already has ${kind}. What now?`,
    choices: [
      { name: 'Rerun to enrich digest', value: 'enrich' },
      { name: 'Add sources and enrich digest', value: 'add-sources' },
      { name: 'Generate complete digest with events', value: 'complete' },
      { name: 'Rerun with new perspective', value: 'perspective' },
      { name: 'Skip', value: 'skip' },
    ],
    default: 'skip',
  });
}
