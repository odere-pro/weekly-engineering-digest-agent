import { resolve } from 'node:path';
import { errorMessage } from '../../../shared/errors';
import { DEFAULT_CONFIG_PATH } from '../paths';
import type { InitIo } from '../types';

/**
 * The text that tells the user how to run the digest weekly: the OS schedule to save and how to
 * install it. A platform with no snippet gets the reason and the two ways to schedule by hand.
 */
export function scheduleSection(io: InitIo, configPath: string, cron: string): string {
  try {
    const schedule = io.renderSchedule(io.platform, {
      cron,
      command: scheduleCommand(io, configPath),
      workingDir: io.cwd,
    });
    const content = schedule.content.endsWith('\n') ? schedule.content : `${schedule.content}\n`;
    return `\nTo run the digest weekly, save this as ${schedule.path}:\n\n${content}\n${schedule.installHint}\n`;
  } catch (error) {
    return `\nNo OS schedule snippet is available (${errorMessage(error)}). Run "digest run" weekly from your scheduler, or keep "digest serve" running.\n`;
  }
}

/**
 * The command a scheduler can run from any folder: this node binary and script. A TypeScript
 * entry point (a dev run through tsx) cannot be started by plain node, so it falls back to
 * the installed `digest` command.
 */
export function defaultScheduleProgram(): string {
  const script = process.argv[1];
  if (!script || /\.[cm]?tsx?$/.test(script)) return 'digest';
  return [process.execPath, resolve(script)].map(quoteIfSpaced).join(' ');
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
