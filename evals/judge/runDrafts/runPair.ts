// Turns a saved run into rows of the judge grading sheet (W3-04): every draft the run's judge
// scored is rendered as the run would print it and gets a row to grade. The judge's scores are
// kept apart (scores/<week>.json) and revealed once the maintainer has graded the week, so they
// cannot anchor a grade. Pure: `addRun.ts` reads and writes the files. Calls no model.
import { z } from 'zod';
import { WeekIdSchema, type Draft } from '../../../src/domain/schemas';
import { renderDigest } from '../../../src/render/markdown';
import { DigestError } from '../../../src/shared/errors';
import type { RunRecord } from '../../../src/store/runRecord';
import type { GradedDigest, GradingSheet } from '../gradingSheet';

/** Where the saved drafts live, as the sheet's `draft` paths name it (repo-relative). */
const DRAFT_FOLDER = 'evals/judge';
const SLUG_MAX_CHARS = 80;

/** One scored draft, ready to save and to add to the sheet. */
export interface DraftToGrade {
  /** The run's ISO week id, checked by RunRecordSchema. */
  readonly week: string;
  readonly writer: string;
  /** The repo-relative path the sheet records, e.g. evals/judge/2026-W43/gemma4-31b-mlx.md. */
  readonly draft: string;
  /** The same file under the judge folder: <week>/<slug>.md. */
  readonly file: string;
  readonly markdown: string;
  readonly judgeScore: number;
}

/** `scores/<week>.json`: the judge's scores of one week's drafts, and the run they came from. */
export const JudgeScoresSchema = z.object({
  week: WeekIdSchema,
  judge: z.string().min(1),
  runStartedAt: z.string().min(1),
  scores: z.array(z.object({ writer: z.string().min(1), judgeScore: z.number().min(1).max(5) })),
});
export type JudgeScores = z.infer<typeof JudgeScoresSchema>;

/** A model tag as a file name: letters and digits joined by dashes, so never a path. */
export function writerSlug(writer: string): string {
  const slug = writer
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part !== '')
    .join('-')
    .slice(0, SLUG_MAX_CHARS);
  if (slug === '') throw new DigestError(`The writer tag "${writer}" has no letter or digit.`);
  return slug;
}

/** The model tag of the run's judge; a run without exactly one judge has no scores to grade. */
export function judgeOf(record: RunRecord): string {
  const judge = record.modelsByRole['judge'];
  if (typeof judge !== 'string' || judge === '') {
    throw new DigestError(
      `Run ${record.runId} has no judge: only a profile with a judge (quality) scores its drafts.`,
    );
  }
  return judge;
}

/** One row per draft the judge scored, in the run's draft order. */
export function draftsToGrade(record: RunRecord, drafts: readonly Draft[]): DraftToGrade[] {
  const week = record.runId;
  const rows = record.drafts.flatMap((outcome) => {
    if (outcome.score === undefined) return [];
    const saved = drafts.find((draft) => draft.writer === outcome.writer);
    if (saved === undefined) {
      throw new DigestError(`drafts.json has no draft by ${outcome.writer} for ${week}.`);
    }
    const file = `${week}/${writerSlug(outcome.writer)}.md`;
    return [
      {
        week,
        writer: outcome.writer,
        draft: `${DRAFT_FOLDER}/${file}`,
        file,
        markdown: renderDigest(saved.digest, { disabledGuards: record.disabledGuards }),
        judgeScore: outcome.score.score,
      },
    ];
  });
  if (rows.length === 0) throw new DigestError(`Run ${week} has no draft the judge scored.`);
  const twin = rows.find((row, index) => rows.findIndex((r) => r.file === row.file) !== index);
  if (twin !== undefined) {
    throw new DigestError(`Two writers in ${week} would save to the same file, ${twin.file}.`);
  }
  return rows;
}

/** Where a week's judge scores are saved under the judge folder: apart from the drafts read. */
export function scoresFile(week: string): string {
  return `scores/${week}.json`;
}

/** What `scores/<week>.json` holds for these rows. */
export function judgeScoresOf(
  record: RunRecord,
  judge: string,
  rows: readonly DraftToGrade[],
): JudgeScores {
  return {
    week: record.runId,
    judge,
    runStartedAt: record.startedAt,
    scores: rows.map(({ writer, judgeScore }) => ({ writer, judgeScore })),
  };
}

const isBlank = (digest: GradedDigest): boolean =>
  digest.week === null &&
  digest.writer === null &&
  digest.draft === null &&
  digest.humanGrade === null &&
  digest.judgeScore === null;

function unusedId(digests: readonly GradedDigest[]): string {
  const taken = new Set(digests.map((digest) => digest.id));
  let next = digests.length + 1;
  while (taken.has(`d${String(next).padStart(2, '0')}`)) next += 1;
  return `d${String(next).padStart(2, '0')}`;
}

function place(digests: readonly GradedDigest[], row: DraftToGrade): GradedDigest[] {
  if (digests.some((d) => d.week === row.week && d.writer === row.writer)) return [...digests];
  const toGrade = { week: row.week, writer: row.writer, draft: row.draft, judgeScore: null };
  const blank = digests.findIndex(isBlank);
  if (blank >= 0) {
    return digests.map((digest, index) => (index === blank ? { ...digest, ...toGrade } : digest));
  }
  return [...digests, { id: unusedId(digests), ...toGrade, humanGrade: null, notes: '' }];
}

/**
 * The sheet with a row to grade for each draft, its judge score left out: the first blank row is
 * filled, else a row is added. A row for the same week and writer is kept as it is. Scores from
 * another judge are refused: they would not be comparable.
 */
export function addToSheet(
  sheet: GradingSheet,
  judge: string,
  rows: readonly DraftToGrade[],
): GradingSheet {
  if (sheet.judge !== null && sheet.judge !== judge) {
    throw new DigestError(
      `grades.json holds scores from ${sheet.judge}; this run's judge is ${judge}.`,
    );
  }
  const digests = rows.reduce<GradedDigest[]>((all, row) => place(all, row), [...sheet.digests]);
  return { ...sheet, judge, digests };
}

/** The result of revealing: the sheet, and the ids of rows still waiting for a grade. */
export interface Revealed {
  readonly sheet: GradingSheet;
  readonly revealed: number;
  readonly waiting: readonly string[];
}

const isFilled = (
  digest: GradedDigest,
): digest is GradedDigest & { week: string; writer: string } =>
  digest.week !== null && digest.writer !== null;

function savedScore(
  saved: readonly JudgeScores[],
  week: string,
  writer: string,
  id: string,
): number {
  const score = saved
    .find((file) => file.week === week)
    ?.scores.find((entry) => entry.writer === writer);
  if (score === undefined) {
    throw new DigestError(`No saved judge score for ${writer} in ${week} (${id}).`);
  }
  return score.judgeScore;
}

/**
 * Fills `judgeScore` from the weeks' saved scores, a week at a time: only once every draft of that
 * week has a grade, so one revealed score cannot sway the grade of its rival.
 */
export function revealScores(sheet: GradingSheet, saved: readonly JudgeScores[]): Revealed {
  const other = saved.find((file) => sheet.judge !== null && file.judge !== sheet.judge);
  if (other !== undefined) {
    throw new DigestError(
      `The saved scores for ${other.week} are from ${other.judge}; grades.json holds ${String(sheet.judge)}.`,
    );
  }
  const filled = sheet.digests.filter(isFilled);
  const ungraded = filled.filter((digest) => digest.humanGrade === null);
  const openWeeks = new Set(ungraded.map((digest) => digest.week));
  const due = new Set(
    filled
      .filter((digest) => digest.judgeScore === null && !openWeeks.has(digest.week))
      .map((digest) => digest.id),
  );
  const digests = sheet.digests.map((digest) =>
    isFilled(digest) && due.has(digest.id)
      ? { ...digest, judgeScore: savedScore(saved, digest.week, digest.writer, digest.id) }
      : digest,
  );
  return {
    sheet: { ...sheet, digests },
    revealed: due.size,
    waiting: ungraded.map((digest) => digest.id),
  };
}
