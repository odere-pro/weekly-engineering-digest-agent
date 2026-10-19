// The four sections `digest eval --only <section>` can run, and the scorecard a partial run saves.
import { z } from 'zod';
import { ScorecardSchema, type MetricId, type MetricResult } from './schema';

export const EVAL_SECTIONS = ['guards', 'classify', 'sources', 'weeks'] as const;
export type EvalSection = (typeof EVAL_SECTIONS)[number];

/** The metrics each section measures. A partial scorecard leaves every other metric unmeasured. */
export const SECTION_METRICS: Readonly<Record<EvalSection, readonly MetricId[]>> = {
  guards: ['attackHandling', 'guardAttackRecall', 'groundedness', 'guardFalseBlocks'],
  classify: ['classifierAccuracy'],
  sources: ['sourceParse', 'sourceSummaryFill'],
  weeks: [
    'linkValidity',
    'format',
    'factCarry',
    'guardRealBlocks',
    'mustIncludeRecall',
    'mustExcludeLeaks',
    'writingQuality',
    'selectionAgreement',
    'writerWinRate',
    'stability',
    'runTime',
  ],
};

/** The section named by an `--only` value; undefined when there is none by that name. */
export function parseSection(value: string): EvalSection | undefined {
  return EVAL_SECTIONS.find((section) => section === value);
}

/** The scorecard file: the full scorecard, plus `partial` when only some sections ran. */
export const SavedScorecardSchema = ScorecardSchema.and(
  z.object({ partial: z.array(z.enum(EVAL_SECTIONS)).min(1).optional() }),
);
export type SavedScorecard = z.infer<typeof SavedScorecardSchema>;

/** A metric the run did not try to measure: no value, and no gate result either way. */
export function notRun(metric: MetricResult, section: EvalSection): MetricResult {
  const { byWeek: _byWeek, detail: _detail, itemIdsByRun: _ids, ...rest } = metric;
  return { ...rest, value: null, pass: null, note: `not run (--only ${section})` };
}
