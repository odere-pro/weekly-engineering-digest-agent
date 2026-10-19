import type { SourceReport } from '../sourceRun/types';

export interface Totals {
  sources: number;
  ok: number;
  failed: number;
  items: number;
}

export function totalsOf(reports: readonly SourceReport[]): Totals {
  const ok = reports.filter((report) => report.ok).length;
  return {
    sources: reports.length,
    ok,
    failed: reports.length - ok,
    items: reports.reduce((sum, report) => sum + report.items.length, 0),
  };
}

/** The line under the table: "2 sources: 1 ok, 1 failed, 5 items". */
export function formatTotals(reports: readonly SourceReport[]): string {
  const { sources, ok, failed, items } = totalsOf(reports);
  return `${plural(sources, 'source')}: ${ok} ok, ${failed} failed, ${plural(items, 'item')}`;
}

// A local copy: other commands keep their own, and a shared helper is not decided yet.
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
