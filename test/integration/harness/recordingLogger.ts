import type { LogFields, Logger } from '../../../src/shared/telemetry';

export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields;
}

/** Keeps every line, with the fields of the child loggers it passed through. */
export function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const make = (bound: LogFields): Logger => {
    const write =
      (level: LogLine['level']) =>
      (message: string, fields: LogFields = {}): void => {
        lines.push({ level, message, fields: { ...bound, ...fields } });
      };
    return {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };
  return { logger: make({}), lines };
}
