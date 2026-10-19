import { totalmem } from 'node:os';
import { renderOsSchedule } from '../../../scheduler/osSchedule';
import { systemClock } from '../../../shared/clock';
import { writeSecretFile } from '../envFile/secretFile';
import { DEFAULT_ENV_PATH } from '../paths';
import { defaultScheduleProgram } from '../schedule/schedule';
import type { InitIo } from '../types';
import { isEmptyFile, pathExists, readTextIfPresent, writeTextFile } from './files';
import { inquirerPrompts } from './inquirerPrompts';

/** The real machine: the terminal, this process, the disk and the OS scheduler. Tests replace parts of it. */
export function createDefaultIo(): InitIo {
  return {
    prompts: inquirerPrompts,
    env: process.env,
    platform: process.platform,
    totalMemoryBytes: totalmem(),
    memoryLimitBytes: process.constrainedMemory(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    clock: systemClock,
    cwd: process.cwd(),
    envPath: DEFAULT_ENV_PATH,
    scheduleProgram: defaultScheduleProgram(),
    renderSchedule: renderOsSchedule,
    exists: pathExists,
    isEmptyFile,
    readFile: readTextIfPresent,
    writeFile: writeTextFile,
    writeSecretFile,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}
