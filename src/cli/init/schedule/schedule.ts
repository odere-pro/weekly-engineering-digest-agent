import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorMessage } from '../../../shared/errors';
import { DEFAULT_CONFIG_PATH } from '../paths';
import type { InitIo } from '../types';

/** `package.json` `bin`: what `pnpm build` writes and what a scheduler can start with node. */
const BUILT_CLI_PARTS = ['dist', 'artifacts', 'cli.js'];
/** `src/cli/index.ts` is two folders below the repo root that holds `dist/`. */
const ENTRY_TO_ROOT = ['..', '..'];

/**
 * The text that tells the user how to run the digest weekly: the OS schedule to save and how to
 * install it. A program that is not built yet gets a warning above the snippet. A platform with
 * no snippet gets the reason and the two ways to schedule by hand. `fileExists` is the only
 * disk read, and only for a `<node> <script>` program.
 */
export function scheduleSection(
  io: InitIo,
  configPath: string,
  cron: string,
  fileExists: (path: string) => boolean = existsSync,
): string {
  try {
    const schedule = io.renderSchedule(io.platform, {
      cron,
      command: scheduleCommand(io, configPath),
      workingDir: io.cwd,
    });
    const content = schedule.content.endsWith('\n') ? schedule.content : `${schedule.content}\n`;
    const warning = unbuiltWarning(io.scheduleProgram, fileExists);
    return `${warning}\nTo run the digest weekly, save this as ${schedule.path}:\n\n${content}\n${schedule.installHint}\n`;
  } catch (error) {
    return `\nNo OS schedule snippet is available (${errorMessage(error)}). Run "digest run" weekly from your scheduler, or keep "digest serve" running.\n`;
  }
}

/**
 * The command a scheduler can run from any folder: this node binary and an absolute script. A
 * TypeScript entry (a dev run through tsx) cannot be started by plain node, so it runs the
 * built CLI of the same repo, `dist/artifacts/cli.js`, whether or not it is built yet:
 * `scheduleSection` warns when it is not. With no script at all the program is the bare
 * `digest`, which the OS renderer refuses: launchd and systemd do not search PATH.
 */
export function defaultScheduleProgram(script: string | undefined = process.argv[1]): string {
  if (!script) return 'digest';
  const entry = /\.[cm]?tsx?$/.test(script) ? builtCliOf(script) : resolve(script);
  return [process.execPath, entry].map(quoteIfSpaced).join(' ');
}

/** The built CLI of the repo that holds the TypeScript entry `script` (`<root>/src/cli/index.ts`). */
function builtCliOf(script: string): string {
  return resolve(dirname(resolve(script)), ...ENTRY_TO_ROOT, ...BUILT_CLI_PARTS);
}

/** The line to print above the snippet when `program` is `<node> <script>` and the script is missing. */
function unbuiltWarning(program: string, fileExists: (path: string) => boolean): string {
  const script = scriptOf(program);
  if (script === undefined || fileExists(script)) return '';
  return (
    `\nWarning: ${script} does not exist yet, so the schedule below would fail. ` +
    'Run "pnpm build" first.\n'
  );
}

/** The script of a `<node> <script>` program, without quotes; undefined for any other program. */
function scriptOf(program: string): string | undefined {
  const prefix = `${quoteIfSpaced(process.execPath)} `;
  if (!program.startsWith(prefix)) return undefined;
  return program.slice(prefix.length).replace(/^"(.*)"$/, '$1');
}

/** "<program> [-c <config>] run": a config outside ./digest.config.json is passed on explicitly. */
export function scheduleCommand(io: InitIo, configPath: string): string {
  const absoluteConfig = resolve(io.cwd, configPath);
  const isDefault = absoluteConfig === resolve(io.cwd, DEFAULT_CONFIG_PATH);
  return [
    io.scheduleProgram,
    ...(isDefault ? [] : ['-c', quoteIfSpaced(absoluteConfig)]),
    'run',
  ].join(' ');
}

export function quoteIfSpaced(part: string): string {
  return /\s/.test(part) ? `"${part}"` : part;
}
