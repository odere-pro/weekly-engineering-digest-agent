import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../shared/errors';
import { dayOf, LOG_FILE, logsDir } from '../store/layout';

export interface DailyLogFileOptions {
  /** The data folder; lines go to <dataDir>/logs/<day>/digest.log (`store/layout.ts`). */
  dataDir: string;
  /** The day of a line is its date in this zone, as for the run's ISO week. */
  timeZone: string;
  /** Injected for tests. */
  now?: () => Date;
  /** Told about the first failed write; later failures are not reported again. */
  onError?: (error: unknown) => void;
}

/** A pino destination: one JSON line per `write`. */
export interface LogLineSink {
  write(line: string): void;
}

/**
 * Appends every log line to the file of the day it is written, so a `serve` process that runs for
 * weeks starts a new file at midnight. Writes are synchronous: lines keep their order and nothing
 * is lost when the process exits. A failed write never throws: the line still reached stdout.
 */
export function createDailyLogFile(options: DailyLogFileOptions): LogLineSink {
  const now = options.now ?? ((): Date => new Date());
  const onError = options.onError ?? reportToStderr;
  let readyDir: string | undefined;
  let reported = false;

  function append(line: string): void {
    const dir = logsDir(options.dataDir, dayOf(now(), options.timeZone));
    if (dir !== readyDir) {
      mkdirSync(dir, { recursive: true });
      readyDir = dir;
    }
    appendFileSync(join(dir, LOG_FILE), line);
  }

  return {
    write(line) {
      try {
        append(line);
        return;
      } catch {
        // The folder may have been removed under a running process: make it again, once.
        readyDir = undefined;
      }
      try {
        append(line);
      } catch (error) {
        readyDir = undefined;
        if (reported) return;
        reported = true;
        onError(error);
      }
    },
  };
}

function reportToStderr(error: unknown): void {
  process.stderr.write(
    `Warning: could not write the log file, logs go to stdout only: ${errorMessage(error)}\n`,
  );
}
