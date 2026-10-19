// Test kit for the judge folders: hand-built grading sheets. Not product code; coverage skips
// `__fixtures__/`.
import { GradingSheetSchema, type GradingSheet } from '../gradingSheet';

/** Grade pairs from two lists of equal length. */
export const pairs = (human: number[], judge: number[]): { human: number; judge: number }[] =>
  human.map((h, i) => ({ human: h, judge: judge[i] ?? 0 }));

/** One row of a sheet, any field of which may be null (not filled in yet). */
export interface Row {
  id: string;
  week: string | null;
  writer: string | null;
  humanGrade: number | null;
  judgeScore: number | null;
}

export const row = (
  id: string,
  week: string,
  writer: string,
  humanGrade: number | null,
  judgeScore: number | null,
): Row => ({ id, week, writer, humanGrade, judgeScore });

/** A parsed sheet: the schema fills in `draft`, `notes` and the other defaults. */
export function sheetOf(
  digests: Row[],
  picks: GradingSheet['picks'] = [],
  judge: string | null = null,
): GradingSheet {
  return GradingSheetSchema.parse({ judge, digests, picks });
}

/** Five weeks, two writers each: the human prefers `a`, and so does the judge, except in W05. */
export function fullSheet(): GradingSheet {
  const digests = [
    row('d01', '2026-W01', 'a', 5, 4.75),
    row('d02', '2026-W01', 'b', 3, 3.5),
    row('d03', '2026-W02', 'a', 4, 4),
    row('d04', '2026-W02', 'b', 2, 2.25),
    row('d05', '2026-W03', 'a', 4, 4.25),
    row('d06', '2026-W03', 'b', 3, 3),
    row('d07', '2026-W04', 'a', 5, 4.5),
    row('d08', '2026-W04', 'b', 4, 3.25),
    row('d09', '2026-W05', 'a', 4, 2.5),
    row('d10', '2026-W05', 'b', 2, 3.75),
  ];
  const picks = ['W01', 'W02', 'W03', 'W04', 'W05'].map((w) => ({
    week: `2026-${w}`,
    better: 'a',
  }));
  return sheetOf(digests, picks, 'clef:latest');
}
