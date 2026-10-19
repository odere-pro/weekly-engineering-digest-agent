// Shared set-up for the ending tests: an ending context over the in-memory store and two
// capturing channels, a logger that keeps its lines, and the run records the cases start from.
import type { LogFields, Logger } from '../../../shared/telemetry';
import type { RunRecord } from '../../../store/runRecord';
import { makeRunRecord } from '../../../../test/builders';
import { CapturingDelivery, MemoryRunStore } from '../../../../test/fakes';
import type { EndingContext } from '../types';

export const WEEK = '2026-W42';

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

export function recordingLogger(lines: LogLine[]): Logger {
  const at =
    (level: LogLine['level']) =>
    (message: string, fields: LogFields = {}): void => {
      lines.push({ level, message, fields });
    };
  const logger: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  };
  return logger;
}

/** An ending context for `WEEK`; `context` overrides any of its fields. */
export function setupEnding(context: Partial<EndingContext> = {}) {
  const logs: LogLine[] = [];
  const store = new MemoryRunStore();
  const deliveries = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
  const ctx: EndingContext = {
    weekId: WEEK,
    dryRun: false,
    logger: recordingLogger(logs),
    deps: { store, deliveries, config: { keepWeeks: 6 } },
    ...context,
  };
  return { ctx, store, deliveries, logs };
}

export const record = (overrides: Partial<RunRecord>): RunRecord =>
  makeRunRecord({ runId: WEEK, finishedAt: '2026-10-16T08:00:00.000Z', ...overrides });

/** A failed run that one channel already took. */
export const partly = record({ status: 'failed', deliveredTo: ['markdown'] });
export const sent = record({ status: 'sent' });
