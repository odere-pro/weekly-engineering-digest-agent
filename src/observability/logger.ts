import type { Logger } from '../shared/telemetry.js';
import { NotImplementedError } from '../shared/errors.js';

export interface LoggerOptions {
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Human-readable output for local dev. */
  pretty?: boolean;
  /** Secret values that must never appear in logs. */
  redactValues?: readonly string[];
  /** Injected for tests. */
  destination?: NodeJS.WritableStream;
}

/** Structured JSON logs to stdout via pino (W1-15). */
export function createLogger(_options: LoggerOptions): Logger {
  throw new NotImplementedError('W1-15');
}
