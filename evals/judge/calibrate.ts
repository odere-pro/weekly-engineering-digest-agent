// Judge calibration check (W3-04): compares the maintainer's hand grades with the judge's scores
// from a grading sheet and writes evals/judge/calibration.json, which `digest eval` reads. No model
// is called here. The statistics are in stats/, the week-by-week selection in selection/.
//   pnpm exec tsx evals/judge/calibrate.ts [sheet.json] [calibration.json] [--min-digests N]
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DigestError, errorMessage } from '../../src/shared/errors';
import {
  JUDGE_AGREEMENT_MIN,
  judgeAgreement,
  selectionAgreement,
} from '../metrics/judging/judgeMetrics';
import type { Measurement } from '../metrics/measurement/measurement';
import { JudgeCalibrationSchema, type JudgeCalibration } from '../schema';
import { GRADED_DIGESTS, GradingSheetSchema, type GradingSheet } from './gradingSheet';
import { completeDigests } from './selection/completeDigests';
import { selections } from './selection/selections';
import { meanAbsoluteDifference } from './stats/meanAbsoluteDifference';
import { spearman } from './stats/rankCorrelation';

const DEFAULT_SHEET = fileURLToPath(new URL('./grades.json', import.meta.url));
const DEFAULT_OUT = fileURLToPath(new URL('./calibration.json', import.meta.url));

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
