import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createSourceArchive,
  type SavedSource,
} from '../../../sources/adapters/archive/sourceArchive';
import { toJson } from '../../../digest/runEnding';
import type { Plan } from '../plan/types';
import { summaryOf } from '../report/summaryOf';
import type { Recorder } from '../sourceRun/recorder';
import type { FetchRun, SourceReport } from '../sourceRun/types';
import { runFolderOf } from './runFolder';

export const SUMMARY_FILE = 'fetch-summary.json';

/** What `saveRun` reads of the plan. */
export type SavePlan = Pick<Plan, 'root' | 'day' | 'startedAt' | 'windowDays'> & {
  run: Pick<FetchRun, 'window'> & { recorder: Pick<Recorder, 'answers'> };
};

/** Cleans a text of secrets. */
type Redact = (text: string) => string;

/**
 * Saves each source's answers and items (`SourceArchive`), then the summary, last, so a day folder
 * whose summary is there is complete. Texts the command wrote itself (errors, summary) are cleaned
 * of every secret; the collected data (response bodies, items) only of the GitHub token, the one
 * secret this command sends, so another secret that happens to be a common string cannot change
 * what a feed said. The day folder must exist (`createRunFolder`).
 */
export async function saveRun(
  plan: SavePlan,
  reports: readonly SourceReport[],
  redact: { generated: Redact; collected: Redact },
): Promise<void> {
  const archive = createSourceArchive({ dataDir: plan.root, redact: redact.collected });
  const saved: SavedSource[] = [];
  for (const report of reports) {
    const answers = plan.run.recorder.answers(report.source.id);
    const items = report.ok ? { items: report.items } : {};
    saved.push(await archive.save(plan.day, report.source.id, { answers, ...items }));
  }
  const summary = toJson(summaryOf(plan, reports, saved));
  await writeFile(join(runFolderOf(plan), SUMMARY_FILE), redact.generated(summary));
}
