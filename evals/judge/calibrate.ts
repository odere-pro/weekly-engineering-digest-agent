// Judge calibration check (W3-04): compares the maintainer's hand grades with the judge's scores
// from a grading sheet and writes evals/judge/calibration.json, which `digest eval` reads. No model
// is called here.
//   pnpm exec tsx evals/judge/calibrate.ts [sheet.json] [calibration.json] [--min-digests N]
//
// Selection agreement: for each week the maintainer picked in, the judge's pick is the draft it
// scored highest among that week's digests. A tie in its scores is no pick, so it counts as a
// disagreement; production breaks such a tie by writer order, which is kinder to the judge.
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DigestError, errorMessage } from '../../src/shared/errors.js';
import {
  JUDGE_AGREEMENT_MIN,
  judgeAgreement,
  selectionAgreement,
  type Measurement,
} from '../metrics.js';
import { JudgeCalibrationSchema, type JudgeCalibration } from '../schema.js';
import {
  GRADED_DIGESTS,
  GradingSheetSchema,
  type GradedDigest,
  type GradingSheet,
} from './gradingSheet.js';

const DEFAULT_SHEET = fileURLToPath(new URL('./grades.json', import.meta.url));
const DEFAULT_OUT = fileURLToPath(new URL('./calibration.json', import.meta.url));
/** Judge scores closer than this are a tie; the same bar the select step uses. */
const SCORE_TIE_EPSILON = 1e-9;

interface GradePair {
  human: number;
  judge: number;
}

// --- Statistics -----------------------------------------------------------------------------

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** Rank of each value, 1 for the smallest; equal values share the mean of their ranks. */
function averageRanks(values: readonly number[]): number[] {
  return values.map((value) => {
    const below = values.filter((other) => other < value).length;
    const equal = values.filter((other) => other === value).length;
    return below + (equal + 1) / 2;
  });
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  const sxy = xs.reduce((sum, x, i) => sum + (x - mx) * ((ys[i] ?? 0) - my), 0);
  const sxx = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  const syy = ys.reduce((sum, y) => sum + (y - my) ** 2, 0);
  if (sxx === 0 || syy === 0) return null;
  // Rounding can push a perfect correlation a hair past 1.
  return Math.min(1, Math.max(-1, sxy / Math.sqrt(sxx * syy)));
}

/**
 * Rank correlation of the hand grades and the judge scores, -1 to 1. Null when it is undefined:
 * fewer than two pairs, or one side never changes.
 */
export function spearman(pairs: readonly GradePair[]): number | null {
  return pearson(averageRanks(pairs.map((p) => p.human)), averageRanks(pairs.map((p) => p.judge)));
}

/** Mean distance between a hand grade and the judge's score, in points; null without pairs. */
export function meanAbsoluteDifference(pairs: readonly GradePair[]): number | null {
  return pairs.length === 0 ? null : mean(pairs.map((p) => Math.abs(p.judge - p.human)));
}

// --- The sheet ------------------------------------------------------------------------------

interface CompleteDigest {
  id: string;
  week: string;
  writer: string;
  humanGrade: number;
  judgeScore: number;
}

/** The fields of a digest that are still null, in the order the maintainer fills them. */
function missingFields(digest: GradedDigest): string[] {
  const fields = ['week', 'writer', 'humanGrade', 'judgeScore'] as const;
  return fields.filter((field) => digest[field] === null);
}

function completeDigests(sheet: GradingSheet): CompleteDigest[] {
  const incomplete = sheet.digests.flatMap((digest) => {
    const missing = missingFields(digest);
    return missing.length > 0 ? [`${digest.id} (${missing.join(', ')})`] : [];
  });
  if (incomplete.length > 0) {
    throw new DigestError(
      `The grading sheet is still missing values: ${incomplete.join(', ')}. ` +
        'Fill them in, or delete the rows you do not grade.',
    );
  }
  return sheet.digests.flatMap(({ id, week, writer, humanGrade, judgeScore }) =>
    week === null || writer === null || humanGrade === null || judgeScore === null
      ? []
      : [{ id, week, writer, humanGrade, judgeScore }],
  );
}

/** The writer with the highest judge score; '' on a tie, as the judge then shows no preference. */
function judgePick(drafts: readonly CompleteDigest[]): string {
  const top = Math.max(...drafts.map((d) => d.judgeScore));
  const leaders = drafts.filter((d) => top - d.judgeScore <= SCORE_TIE_EPSILON);
  return leaders.length === 1 ? (leaders[0]?.writer ?? '') : '';
}

/** For each week the maintainer picked in: their pick and the draft the judge scored highest. */
function selections(
  digests: readonly CompleteDigest[],
  picks: GradingSheet['picks'],
): { human: string; judge: string }[] {
  if (picks.length === 0) {
    throw new DigestError(
      'The grading sheet needs at least one pick: selection agreement compares your pick ' +
        "between two drafts of a week with the judge's.",
    );
  }
  return picks.map(({ week, better }) => {
    const drafts = digests.filter((d) => d.week === week);
    const writers = new Set(drafts.map((d) => d.writer));
    if (writers.size < 2) {
      throw new DigestError(
        `Cannot compare drafts of ${week}: the sheet needs digests from two different writers, it has ${writers.size}.`,
      );
    }
    if (!drafts.some((d) => d.writer === better)) {
      throw new DigestError(
        `The pick for ${week} names "${better}", which has no digest that week (writers: ${[...writers].join(', ')}).`,
      );
    }
    return { human: better, judge: judgePick(drafts) };
  });
}

function required(measurement: Measurement, name: string): number {
  if (measurement.value === null) throw new DigestError(`Cannot work out the ${name}.`);
  return measurement.value;
}

/**
 * Judge agreement (within half a point of the hand grade), selection agreement, rank correlation
 * and mean absolute difference, for a completed sheet of at least `minDigests` digests (the
 * spec's 10): too few would let a lucky pair un-gate the judge. Throws a DigestError that lists
 * what is still missing, so a half-filled sheet never yields a number.
 */
export function calibrate(
  sheet: GradingSheet,
  { minDigests = GRADED_DIGESTS }: { minDigests?: number } = {},
): JudgeCalibration {
  if (sheet.digests.length < minDigests) {
    throw new DigestError(
      `The spec calibrates the judge on ${minDigests} hand-graded digests and the sheet has ` +
        `${sheet.digests.length}. Add rows, or pass --min-digests to accept fewer.`,
    );
  }
  const digests = completeDigests(sheet);
  const pairs = digests.map((d) => ({ human: d.humanGrade, judge: d.judgeScore }));
  const agreement = required(judgeAgreement(pairs), 'judge agreement');
  const selected = required(
    selectionAgreement(selections(digests, sheet.picks)),
    'selection agreement',
  );
  return JudgeCalibrationSchema.parse({
    judgeAgreement: agreement,
    selectionAgreement: selected,
    gradedDigests: digests.length,
    spearman: spearman(pairs),
    meanAbsoluteDifference: meanAbsoluteDifference(pairs),
    ...(sheet.judge === null ? {} : { judge: sheet.judge }),
  });
}

// --- Files ----------------------------------------------------------------------------------

async function readSheet(path: string): Promise<GradingSheet> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new DigestError(`Cannot read ${path}: ${errorMessage(error)}`, { cause: error });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new DigestError(`${path} is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  const parsed = GradingSheetSchema.safeParse(json);
  if (!parsed.success) {
    throw new DigestError(
      `${path} does not match the grading sheet:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

function reportLines(result: JudgeCalibration, outPath: string): string[] {
  const trusted = result.judgeAgreement >= JUDGE_AGREEMENT_MIN;
  const correlation =
    typeof result.spearman === 'number'
      ? result.spearman.toFixed(2)
      : 'undefined (the grades or the scores are all equal)';
  const difference =
    result.meanAbsoluteDifference === undefined
      ? 'n/a'
      : `${result.meanAbsoluteDifference.toFixed(2)} points`;
  return [
    `Judge agreement: ${percent(result.judgeAgreement)} of ${result.gradedDigests} digests within half a point of your grade`,
    `Selection agreement: ${percent(result.selectionAgreement)} of the weeks you picked in`,
    `Spearman rank correlation: ${correlation}`,
    `Mean absolute difference: ${difference}`,
    trusted
      ? `The judge agrees at least ${percent(JUDGE_AGREEMENT_MIN)}: the judge scores are gated.`
      : `The judge agrees under ${percent(JUDGE_AGREEMENT_MIN)}: the judge scores are reported, not gated.`,
    `Wrote ${outPath}`,
  ];
}

export interface CalibrationOptions {
  /** The filled-in grading sheet. */
  sheetPath: string;
  /** Where calibration.json goes. */
  outPath: string;
  /** One report line per call. Default: console.log. */
  log?: (line: string) => void;
  /** Fewest digests the sheet may have. Default: the spec's 10. */
  minDigests?: number;
}

/** Reads the sheet, writes the calibration next to it, prints what it found and returns it. */
export async function runCalibration(options: CalibrationOptions): Promise<JudgeCalibration> {
  const log =
    options.log ??
    ((line: string) => {
      console.log(line);
    });
  const result = calibrate(await readSheet(options.sheetPath), {
    ...(options.minDigests === undefined ? {} : { minDigests: options.minDigests }),
  });
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${JSON.stringify(result, null, 2)}\n`);
  for (const line of reportLines(result, options.outPath)) log(line);
  return result;
}

/** Reads `--min-digests`; a value that is not a whole number of 1 or more is an error. */
function parseMinDigests(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DigestError(`--min-digests needs a whole number of 1 or more, not "${value}".`);
  }
  return parsed;
}

/** The command line: returns the exit code. */
export async function main(
  args: readonly string[],
  log?: (line: string) => void,
  fail: (line: string) => void = (line) => {
    console.error(line);
  },
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { 'min-digests': { type: 'string' } },
      allowPositionals: true,
    });
    const [sheetPath = DEFAULT_SHEET, outPath = DEFAULT_OUT] = positionals;
    const minDigests = parseMinDigests(values['min-digests']);
    await runCalibration({
      sheetPath,
      outPath,
      ...(log ? { log } : {}),
      ...(minDigests === undefined ? {} : { minDigests }),
    });
    return 0;
  } catch (error) {
    fail(`calibrate failed: ${errorMessage(error)}`);
    return 1;
  }
}

// realpath: node resolves symlinks for the entry module, so argv[1] must be resolved the same way.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.exitCode = await main(process.argv.slice(2));
}
