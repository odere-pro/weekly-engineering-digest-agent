import { createRedactor } from '../../../observability/redact';
import { EXIT_FAILED, EXIT_OK } from './exitCodes';
import type { CheckResult, Severity } from './checkResult';
import { withoutUrlCredentials } from './withoutUrlCredentials';

const SYMBOLS: Readonly<Record<Severity, string>> = { ok: '✓', warn: '!', error: '✗' };

/**
 * Prints every result and a summary line, with the secret values and URL credentials removed from
 * the whole text. `secretValues` is what `knownSecrets` returns, the `OLLAMA_URL` password included.
 * Returns the exit code: 1 if any result is an error, else 0.
 */
export function report(
  results: readonly CheckResult[],
  stdout: (text: string) => void,
  secretValues: readonly string[],
): number {
  const errors = results.filter((r) => r.severity === 'error').length;
  const warnings = results.filter((r) => r.severity === 'warn').length;
  const text = [...results.map(formatResult), '', summary(errors, warnings)].join('\n');
  stdout(`${withoutUrlCredentials(createRedactor(secretValues).text(text))}\n`);
  return errors > 0 ? EXIT_FAILED : EXIT_OK;
}

/** `✓ label: message`; later lines of the message are indented; a warning or error adds `fix:`. */
export function formatResult(result: CheckResult): string {
  const [first = '', ...rest] = result.message.split('\n');
  return [
    `${SYMBOLS[result.severity]} ${result.label}: ${first}`,
    ...rest.map((line) => `    ${line}`),
    ...(result.severity !== 'ok' && result.fix ? [`    fix: ${result.fix}`] : []),
  ].join('\n');
}

export function summary(errors: number, warnings: number): string {
  if (errors === 0 && warnings === 0) return 'Doctor: all checks passed.';
  const plural = (count: number, noun: string): string =>
    `${count} ${noun}${count === 1 ? '' : 's'}`;
  return `Doctor: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}.`;
}
