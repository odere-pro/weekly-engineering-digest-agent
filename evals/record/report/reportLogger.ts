import { createRedactor } from '../../../src/observability/redact';
import type { LogFields, Logger } from '../../../src/shared/telemetry';
import { oneLine } from '../display';
import type { ResolvedSources } from '../types';

/** ` (key=value key=value)`, or nothing without fields. */
function detailsOf(fields: LogFields): string {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${displayed(value)}`);
  return pairs.length === 0 ? '' : ` (${pairs.join(' ')})`;
}

function displayed(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/**
 * The logger the default fetchers get. A feed entry they skip means a recording that lacks it, so
 * a warning or an error becomes a line in the report; lower levels stay out of it. A line is one
 * line and has the GitHub token taken out, like every other log line of the app.
 */
export function reportLogger(
  log: (line: string) => void,
  { githubToken }: Pick<ResolvedSources, 'githubToken'>,
): Logger {
  const redactor = createRedactor(githubToken === undefined ? [] : [githubToken]);
  const lineOf = (label: string, message: string, fields: LogFields): string =>
    oneLine(redactor.text(`${label}: ${message}${detailsOf(redactor.fields(fields))}`));
  const levelLogger = (bindings: LogFields): Logger => {
    const report = (label: string) => (message: string, fields: LogFields) => {
      log(lineOf(label, message, { ...bindings, ...fields }));
    };
    return {
      debug: () => undefined,
      info: () => undefined,
      warn: report('WARNING'),
      error: report('ERROR'),
      child: (fields) => levelLogger({ ...bindings, ...fields }),
    };
  };
  return levelLogger({});
}
