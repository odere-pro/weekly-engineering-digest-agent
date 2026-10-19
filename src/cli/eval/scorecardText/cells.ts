// Table cells shared by the scorecard text and the compare text.
import type { MetricResult } from '../../../../evals/schema';

export function valueCell(metric: MetricResult): string {
  if (metric.value === null) return 'n/a';
  switch (metric.unit) {
    case 'ratio':
      return `${(metric.value * 100).toFixed(1)}%`;
    case 'ms':
      return `${(metric.value / 1000).toFixed(1)} s`;
    default:
      return metric.value.toFixed(2);
  }
}

export function gateCell(metric: MetricResult): string {
  const { gate } = metric;
  if (gate.kind === 'none') return 'reported';
  const threshold =
    metric.unit === 'ratio' ? `${Math.round(gate.threshold * 100)}%` : String(gate.threshold);
  const symbol = gate.direction === 'atLeast' ? '≥' : '≤';
  return `${gate.kind} ${symbol} ${threshold}${gate.needsJudge ? ' (judge)' : ''}`;
}

export function resultCell(metric: MetricResult): string {
  if (metric.pass === null) return '-';
  return metric.pass ? 'PASS' : 'FAIL';
}

export function table(rows: readonly (readonly string[])[]): string[] {
  const widths = (rows[0] ?? []).map((_, col) =>
    Math.max(...rows.map((row) => row[col]?.length ?? 0)),
  );
  return rows.map((row) =>
    row
      .map((cell, col) => cell.padEnd(widths[col] ?? 0))
      .join('  ')
      .trimEnd(),
  );
}
