import type { SavedSource } from '../../../sources/adapters/archive/sourceArchive';
import type { Plan } from '../plan/types';
import type { SourceReport } from '../sourceRun/types';
import { totalsOf } from './totals';

/** What `summaryOf` reads of the plan. */
export type SummaryPlan = Pick<Plan, 'startedAt' | 'windowDays'> & {
  run: { window: Plan['run']['window'] };
};

/**
 * The content of fetch-summary.json. `saved[i]` is what was written for `reports[i]`. A value a
 * source never had is `null`, so every key is in the JSON.
 */
export function summaryOf(
  { startedAt, windowDays, run }: SummaryPlan,
  reports: readonly SourceReport[],
  saved: readonly SavedSource[],
): object {
  return {
    startedAt: startedAt.toISOString(),
    window: {
      since: run.window.since.toISOString(),
      until: run.window.until.toISOString(),
      days: windowDays,
    },
    sources: reports.map((report, i) => ({
      id: report.source.id,
      kind: report.source.kind,
      status: report.ok ? 'ok' : 'failed',
      httpStatus: report.httpStatus ?? null,
      answeredBy: report.answeredBy ?? null,
      entries: report.entries?.parsed ?? null,
      skipped: report.entries?.skipped ?? null,
      items: report.items.length,
      durationMs: report.durationMs,
      error: report.error ?? null,
      raw: saved[i]?.raw ?? [],
      formatted: saved[i]?.formatted ?? null,
    })),
    totals: totalsOf(reports),
  };
}
