import { createRequire } from 'node:module';
import { pino, type Logger as PinoLogger } from 'pino';
import type PinoPretty from 'pino-pretty';
import type { LogFields, Logger } from '../shared/telemetry';
import { createDailyLogFile, type DailyLogFileOptions } from './dailyLogFile';
import { createRedactor, type Redactor } from './redact';

export interface LoggerOptions {
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Human-readable output for local dev. */
  pretty?: boolean;
  /** Secret values that must never appear in logs. */
  redactValues?: readonly string[];
  /** Injected for tests. */
  destination?: NodeJS.WritableStream;
  /** Also write every line as JSON to the day's log file in the data folder. */
  file?: DailyLogFileOptions;
}

const SERVICE_NAME = 'eng-digest';
const nodeRequire = createRequire(import.meta.url);

type LogLevel = LoggerOptions['level'];

/** pino-pretty is a dev dependency: load it only when pretty output is asked for. */
function loadPretty(): typeof PinoPretty {
  try {
    return nodeRequire('pino-pretty') as typeof PinoPretty;
  } catch (error) {
    throw new Error('Pretty logs need the "pino-pretty" package, which is not installed', {
      cause: error,
    });
  }
}

function writeTo(base: PinoLogger, redactor: Redactor, level: LogLevel): Logger[LogLevel] {
  return (message, fields) => {
    if (!base.isLevelEnabled(level)) return;
    const safeMessage = redactor.text(message);
    if (fields === undefined) base[level](safeMessage);
    else base[level](redactor.fields(fields), safeMessage);
  };
}

function wrap(base: PinoLogger, redactor: Redactor): Logger {
  return {
    debug: writeTo(base, redactor, 'debug'),
    info: writeTo(base, redactor, 'info'),
    warn: writeTo(base, redactor, 'warn'),
    error: writeTo(base, redactor, 'error'),
    child: (fields: LogFields) => wrap(base.child(redactor.fields(fields)), redactor),
  };
}

/** Structured JSON logs to stdout via pino (W1-15), and to the day's log file when asked. */
export function createLogger(options: LoggerOptions): Logger {
  const destination = options.destination ?? process.stdout;
  const terminal = options.pretty === true ? loadPretty()({ destination }) : destination;
  const output =
    options.file === undefined
      ? terminal
      : pino.multistream([
          { level: options.level, stream: terminal },
          { level: options.level, stream: createDailyLogFile(options.file) },
        ]);
  const base = pino(
    {
      level: options.level,
      base: { service: SERVICE_NAME },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      // Errors are already flattened (and redacted) by the redactor; pino's own serializer would relabel them.
      serializers: { err: (value: unknown) => value },
    },
    output,
  );
  return wrap(base, createRedactor(options.redactValues));
}
