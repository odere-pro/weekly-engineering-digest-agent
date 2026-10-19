// The grading sheet for the judge calibration (W3-04): the maintainer's hand grades and picks,
// next to the judge's scores for the same digests. `calibrate.ts` reads it. Nothing here calls a
// model; the sheet is plain JSON the maintainer fills in and the judge run completes.
import { z } from 'zod';
import { WeekIdSchema } from '../../src/domain/schemas';

/** Spec: the judge is calibrated on 10 hand-graded digests. */
export const GRADED_DIGESTS = 10;
const GRADE_MIN = 1;
const GRADE_MAX = 5;

const GradeSchema = z.number().min(GRADE_MIN).max(GRADE_MAX);

/**
 * One digest to grade. The fields that start as null are filled in: week, writer and the grades
 * by the people involved, `judgeScore` by the judge run.
 */
export const GradedDigestSchema = z.object({
  id: z.string().min(1),
  week: WeekIdSchema.nullable(),
  /** The model tag of the writer that wrote the draft. */
  writer: z.string().min(1).nullable(),
  /** The saved draft to read, for example evals/judge/2026-W36/gemma4-31b-mlx.md. */
  draft: z.string().min(1).nullable().default(null),
  /** The maintainer's grade, 1 (poor) to 5 (excellent). */
  humanGrade: GradeSchema.nullable(),
  /** The judge's overall score of the same draft, 1 to 5. */
  judgeScore: GradeSchema.nullable(),
  notes: z.string().default(''),
});
export type GradedDigest = z.infer<typeof GradedDigestSchema>;

/** The maintainer's pick between the drafts of one week. */
export const PickSchema = z.object({
  week: WeekIdSchema,
  /** The writer tag of the draft the maintainer prefers. */
  better: z.string().min(1),
});

const hasDuplicates = (values: readonly string[]): boolean => new Set(values).size < values.length;

export const GradingSheetSchema = z
  .object({
    /** What to fill in; ignored when reading. */
    instructions: z.string().optional(),
    /** The model tag of the judge that produced the `judgeScore` values. */
    judge: z.string().min(1).nullable().default(null),
    digests: z.array(GradedDigestSchema).min(1),
    picks: z.array(PickSchema).default([]),
  })
  .refine((sheet) => !hasDuplicates(sheet.digests.map((digest) => digest.id)), {
    message: 'digest ids must be unique',
    path: ['digests'],
  })
  .refine((sheet) => !hasDuplicates(sheet.picks.map((pick) => pick.week)), {
    message: 'there can be only one pick per week',
    path: ['picks'],
  });
export type GradingSheet = z.infer<typeof GradingSheetSchema>;

const INSTRUCTIONS = [
  'After a quality run, pnpm exec tsx evals/judge/runDrafts/addRun.ts dist/<monday>/digest',
  'saves its drafts and fills week, writer and draft here (it starts evals/judge/grades.json',
  'from this file).',
  'Read the sources, then the draft, and set humanGrade from 1 (poor) to 5 (excellent), judging as',
  'the judge rubric does: accuracy against the sources, clarity, why it matters, fit with the focus',
  'areas. Delete the rows you do not use.',
  'Under picks, add one entry per week where you compared two drafts:',
  '{ "week": "2026-W36", "better": "<writer tag of the draft you prefer>" }.',
  'Leave judge and judgeScore alone: after you grade, addRun.ts --reveal fills judgeScore.',
  'When every row is complete, run: pnpm exec tsx evals/judge/calibrate.ts',
].join(' ');

/** A blank sheet with a row for each digest to grade (10, as the spec asks). */
export function createGradingSheetTemplate(count = GRADED_DIGESTS): GradingSheet {
  return {
    instructions: INSTRUCTIONS,
    judge: null,
    digests: Array.from({ length: count }, (_, index) => ({
      id: `d${String(index + 1).padStart(2, '0')}`,
      week: null,
      writer: null,
      draft: null,
      humanGrade: null,
      judgeScore: null,
      notes: '',
    })),
    picks: [],
  };
}
