import type { z } from 'zod';
import { problemLines, OutcomeNotesSchema } from './problemLines';
import { cell, formatScore, table } from './table';
import { parseFile } from '../parseFile';
import { DraftsFileSchema } from '../../../digest/runEnding';
import type { RunStore } from '../../../store/RunStore';

const itemCount = (file: z.infer<typeof DraftsFileSchema>, writer: string): string =>
  String(file.drafts.find((draft) => draft.writer === writer)?.digest.items.length ?? 0);

/**
 * One row per writer: the run record's outcomes first, then drafts the record does not know.
 * The "Problems:" block follows with what `drafts.json` says about rejected and failed writers.
 */
export async function draftsTable(week: string, raw: string, store: RunStore): Promise<string> {
  const record = await store.getRunRecord(week);
  const file = parseFile('drafts.json', raw, DraftsFileSchema);
  const notes = parseFile('drafts.json', raw, OutcomeNotesSchema);
  const header = ['Writer', 'Passed', 'Rejected by', 'Items', 'Judge'];
  const outcomes = record?.drafts ?? [];
  const known = new Set(outcomes.map((outcome) => outcome.writer));
  const rows = [
    ...outcomes.map((outcome) => [
      cell(outcome.writer),
      outcome.passed ? 'yes' : 'no',
      cell(outcome.rejectedBy.join(', ') || '-'),
      itemCount(file, outcome.writer),
      outcome.score === undefined ? '-' : formatScore(outcome.score.score),
    ]),
    ...file.drafts
      .filter((draft) => !known.has(draft.writer))
      .map((draft) => [cell(draft.writer), '-', '-', itemCount(file, draft.writer), '-']),
  ];
  return `${table([header, ...rows])}${problemLines(notes)}`;
}
