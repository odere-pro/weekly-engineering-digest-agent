import { NotImplementedError } from '../shared/errors.js';

export interface OsScheduleOptions {
  cron: string;
  /** Absolute command, e.g. "/usr/local/bin/digest run". */
  command: string;
  workingDir: string;
}

export interface OsSchedule {
  /** Where the file should be installed. */
  path: string;
  content: string;
  /** Command(s) the user runs to activate it. */
  installHint: string;
}

/** launchd plist (macOS), systemd timer (Linux) or Task Scheduler entry (Windows) (W1-16). */
export function renderOsSchedule(_os: NodeJS.Platform, _options: OsScheduleOptions): OsSchedule {
  throw new NotImplementedError('W1-16');
}
