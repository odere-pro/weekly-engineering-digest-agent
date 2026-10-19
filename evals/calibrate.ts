// Calibrates the decider's relevance from labeled cases (W11-06):
//   tsx evals/calibrate.ts <raw.json> [--holdout 2026-W40,2026-W41] [--write [--out <file>]]
// Fits on the train split of a raw capture only, measures the holdout split with the file off
// and on, and writes the file only when holdout recall rises and leaks do not. No model calls.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ThresholdsSchema, type ProfileName, type Thresholds } from '../src/config/schema';
import type { ScoredItem } from '../src/classify/classification';
import { areaKey, calibrateClassification, type Calibration } from '../src/process/calibration';
import { processStep } from '../src/process/process';
import { DigestError, errorMessage } from '../src/shared/errors';
import { mustExcludeLeaks, mustIncludeRecall, type WeekHits } from './metrics/ranking/labelHits';
import { loadEvalCases } from './cases/loadEvalCases';
import { type EvalCases } from './cases/evalSet';
import { isFailed, RawCaptureSchema, type RawCapture } from './thresholds/capture/schemas';
import {
  defaultSplit,
  parseHoldoutWeeks,
  splitCapture,
  CASE_STRIDE,
  type Split,
} from './thresholds/split';

/** Spec: must-include recall is counted in the top 5. */
const TOP_N = 5;
/** Target relevance of a must-include and of a must-exclude week item. */
const MUST_INCLUDE_TARGET = 3;
const MUST_EXCLUDE_TARGET = 0;
/** An area with n samples keeps n / (n + this) of its mean error as bias. */
const BIAS_SHRINK = 5;
/** No area is moved by more than this. */
const MAX_BIAS = 0.5;
const WITHIN_ONE = 1;
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

export interface Sample {
  /** The decider's raw relevance. */
  raw: number;
  area: string;
  /** The label's relevance, 0-3. */
  target: number;
}

/** Train samples: the classifier cases (their label) and the labeled week items (3 or 0). */
export function trainSamples(capture: RawCapture, split: Split): Sample[] {
  const { train } = splitCapture(capture, split);
  const cases = train.classifier.flatMap((record) =>
    isFailed(record.result)
      ? []
      : [
          {
            raw: record.result.relevance,
            area: record.result.area,
            target: record.expected.relevance,
          },
        ],
  );
  const weekItems = train.weekItems.flatMap((record) => {
    if (record.label === null || isFailed(record.result)) return [];
    const target = record.label === 'mustInclude' ? MUST_INCLUDE_TARGET : MUST_EXCLUDE_TARGET;
    return [{ raw: record.result.relevance, area: record.result.area, target }];
  });
  return [...cases, ...weekItems];
}

interface Block {
  rawSum: number;
  targetSum: number;
  count: number;
}

const blockValue = (block: Block) => ({
  raw: block.rawSum / block.count,
  calibrated: block.targetSum / block.count,
});

/** Samples with the same raw score share one block. */
function groupByRaw(samples: readonly Sample[]): Block[] {
  const groups = new Map<number, Block>();
  for (const { raw, target } of samples) {
    const old = groups.get(raw) ?? { rawSum: 0, targetSum: 0, count: 0 };
    groups.set(raw, {
      rawSum: old.rawSum + raw,
      targetSum: old.targetSum + target,
      count: old.count + 1,
    });
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
}

/** Pool adjacent violators: merge neighbours until the block means never fall. */
function pool(blocks: readonly Block[]): Block[] {
  const stack: Block[] = [];
  for (const block of blocks) {
    let current = block;
    for (
      let last = stack.at(-1);
      last && last.targetSum / last.count >= current.targetSum / current.count;
      last = stack.at(-1)
    ) {
      stack.pop();
      current = {
        rawSum: last.rawSum + current.rawSum,
        targetSum: last.targetSum + current.targetSum,
        count: last.count + current.count,
      };
    }
    stack.push(current);
  }
  return stack;
}

type Points = Calibration['points'];

function evaluate(points: Points, raw: number): number {
  const probe: Calibration = { version: 1, profile: 'light', points, areaBias: {} };
  return calibrateClassification(probe, {
    itemId: '',
    relevance: raw,
    area: 'x',
    areaConfidence: 0,
    hype: 0,
    minorRelease: 0,
  }).relevance;
}

function fitAreaBias(samples: readonly Sample[], points: Points): Record<string, number> {
  const byArea = new Map<string, number[]>();
  for (const sample of samples) {
    const key = areaKey(sample.area);
    byArea.set(key, [...(byArea.get(key) ?? []), sample.target - evaluate(points, sample.raw)]);
  }
  return Object.fromEntries(
    [...byArea.entries()].map(([key, errors]) => {
      const mean = errors.reduce((sum, e) => sum + e, 0) / errors.length;
      const shrunk = (mean * errors.length) / (errors.length + BIAS_SHRINK);
      return [key, Math.max(-MAX_BIAS, Math.min(MAX_BIAS, shrunk))];
    }),
  );
}

/** Isotonic fit of target on raw score (knots at block means) plus a shrunk per-area bias. */
export function fitCalibration(samples: readonly Sample[], profile: ProfileName): Calibration {
  if (samples.length === 0) throw new DigestError('calibration: no samples to fit');
  const points = pool(groupByRaw(samples)).map(blockValue);
  return { version: 1, profile, points, areaBias: fitAreaBias(samples, points) };
}

// --- Measurement ----------------------------------------------------------------------------

export interface SideMeasure {
  /** Mean must-include items in the top 5 per week. */
  recall: number;
  /** Mean must-exclude items in the top 5 per week. */
  leaks: number;
  /** Share of cases with |label - score| of 1 or less. */
  withinOne: number | null;
}

function weekHits(
  side: RawCapture,
  cases: EvalCases,
  thresholds: Thresholds,
  calibration: Calibration | null,
  topN: number,
): WeekHits[] {
  return cases.weeks.flatMap((week) => {
    const records = side.weekItems.filter((r) => r.weekId === week.weekId);
    if (records.length === 0) return [];
    const scored = records.flatMap((record): ScoredItem[] => {
      const item = week.items.find((i) => i.id === record.itemId);
      if (!item || isFailed(record.result)) return [];
      return [{ ...item, classification: { itemId: item.id, ...record.result } }];
    });
    const { selected } = processStep({
      items: scored,
      sentUrls: new Set(),
      thresholds,
      topN,
      calibration: calibration ?? undefined,
    });
    return [
      {
        mustInclude: week.labels.mustInclude,
        mustExclude: week.labels.mustExclude,
        digestItemIds: selected.map((item) => item.id),
        visibleIds: new Set(scored.map((item) => item.id)),
      },
    ];
  });
}

function withinOneShare(side: RawCapture, calibration: Calibration | null): number | null {
  const records = side.classifier.flatMap((r) =>
    isFailed(r.result) ? [] : [{ ...r, ok: r.result }],
  );
  if (records.length === 0) return null;
  const right = records.filter(({ expected, ok }) => {
    const score = calibration
      ? calibrateClassification(calibration, { itemId: '', ...ok }).relevance
      : ok.relevance;
    return Math.abs(expected.relevance - score) <= WITHIN_ONE;
  });
  return right.length / records.length;
}

/** Recall, leaks and within-one accuracy of one side of a capture, with or without the file. */
export function measureSide(
  side: RawCapture,
  cases: EvalCases,
  thresholds: Thresholds,
  calibration: Calibration | null,
  topN: number = TOP_N,
): SideMeasure {
  const hits = weekHits(side, cases, thresholds, calibration, topN);
  return {
    recall: mustIncludeRecall(hits).value ?? 0,
    leaks: mustExcludeLeaks(hits).value ?? 0,
    withinOne: withinOneShare(side, calibration),
  };
}

/** The rule from the issue: holdout recall rises and leaks do not. */
export function keepCalibration(off: SideMeasure, on: SideMeasure): boolean {
  return on.recall > off.recall && on.leaks <= off.leaks;
}

// --- CLI ------------------------------------------------------------------------------------

const EVALS_DIR = fileURLToPath(new URL('.', import.meta.url));
const USAGE =
  'Usage: tsx evals/calibrate.ts <raw.json> [--holdout 2026-W40,2026-W41] [--write [--out <file>]]\n';

export interface CalibrateIo {
  casesDir: string;
  loadCases: (dir: string) => Promise<EvalCases>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CalibrateIo = {
  casesDir: EVALS_DIR,
  loadCases: loadEvalCases,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

const fixed = (value: number | null, digits = 2): string =>
  value === null ? 'n/a' : value.toFixed(digits);

function table(off: SideMeasure, on: SideMeasure, verdict: string): string {
  const row = (name: string, a: number | null, b: number | null, d = 2): string =>
    `${name.padEnd(22)}${fixed(a, d).padStart(8)}${fixed(b, d).padStart(8)}`;
  return [
    `${''.padEnd(22)}${'off'.padStart(8)}${'on'.padStart(8)}`,
    row('holdout recall (of 5)', off.recall, on.recall),
    row('holdout leaks', off.leaks, on.leaks),
    row('within-one accuracy', off.withinOne, on.withinOne, 3),
    verdict,
    '',
  ].join('\n');
}

async function loadRaw(path: string): Promise<RawCapture> {
  return RawCaptureSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** Returns the exit code: 0 done, 1 failed, 2 usage. */
export async function runCli(
  args: readonly string[],
  overrides: Partial<CalibrateIo> = {},
): Promise<number> {
  const io = { ...defaultIo, ...overrides };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: { holdout: { type: 'string' }, write: { type: 'boolean' }, out: { type: 'string' } },
    });
  } catch (error) {
    io.stderr(`${errorMessage(error)}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const [rawPath] = parsed.positionals;
  if (rawPath === undefined) {
    io.stderr(USAGE);
    return EXIT_USAGE;
  }
  try {
    const capture = await loadRaw(rawPath);
    const holdout = parsed.values.holdout;
    const split: Split =
      typeof holdout === 'string'
        ? { holdoutWeeks: parseHoldoutWeeks(holdout), caseStride: CASE_STRIDE }
        : defaultSplit(capture);
    const fit = fitCalibration(trainSamples(capture, split), capture.profile);
    const cases = await io.loadCases(io.casesDir);
    const side = splitCapture(capture, split).holdout;
    const thresholds = ThresholdsSchema.parse({});
    const off = measureSide(side, cases, thresholds, null);
    const on = measureSide(side, cases, thresholds, fit);
    const keep = keepCalibration(off, on);
    io.stdout(
      table(off, on, keep ? 'verdict: keep' : 'verdict: drop (recall did not rise or leaks rose)'),
    );
    if (parsed.values.write === true && keep) {
      const out =
        typeof parsed.values.out === 'string'
          ? parsed.values.out
          : join(io.casesDir, 'calibration', `${capture.profile}.json`);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(fit, null, 2)}\n`);
      io.stdout(`wrote ${out}\n`);
    }
    return EXIT_OK;
  } catch (error) {
    io.stderr(`calibrate failed: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
