import type { SideMeasure } from '../measure/measureSide';

const LABEL_WIDTH = 22;
const VALUE_WIDTH = 8;
const DEFAULT_DIGITS = 2;
const ACCURACY_DIGITS = 3;

const fixed = (value: number | null, digits: number): string =>
  value === null ? 'n/a' : value.toFixed(digits);

function row(name: string, off: number | null, on: number | null, digits = DEFAULT_DIGITS): string {
  const cells = [fixed(off, digits), fixed(on, digits)].map((cell) => cell.padStart(VALUE_WIDTH));
  return `${name.padEnd(LABEL_WIDTH)}${cells.join('')}`;
}

/** The text the command prints: the holdout table with the file off and on, then the verdict. */
export function holdoutReport(off: SideMeasure, on: SideMeasure, keep: boolean): string {
  const verdict = keep ? 'verdict: keep' : 'verdict: drop (recall did not rise or leaks rose)';
  return [
    `${''.padEnd(LABEL_WIDTH)}${'off'.padStart(VALUE_WIDTH)}${'on'.padStart(VALUE_WIDTH)}`,
    row('holdout recall (of 5)', off.recall, on.recall),
    row('holdout leaks', off.leaks, on.leaks),
    row('within-one accuracy', off.withinOne, on.withinOne, ACCURACY_DIGITS),
    verdict,
    '',
  ].join('\n');
}
