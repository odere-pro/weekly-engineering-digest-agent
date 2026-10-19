// Calibrates the decider's relevance from labeled cases (W11-06):
//   tsx evals/calibrate.ts <raw.json> [--holdout 2026-W40,2026-W41] [--write [--out <file>]]
// Fits on the train split of a raw capture only, measures the holdout split with the file off
// and on, and writes the file only when holdout recall rises and leaks do not. No model calls.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ThresholdsSchema } from '../src/config/schema';
import { errorMessage } from '../src/shared/errors';
import { fitCalibration } from './calibration/fit/fitCalibration';
import { trainSamples } from './calibration/fit/trainSamples';
import { keepCalibration } from './calibration/measure/keepCalibration';
import { measureSide } from './calibration/measure/measureSide';
import { holdoutReport } from './calibration/report/holdoutReport';
import { loadEvalCases } from './cases/loadEvalCases';
import type { EvalCases } from './cases/evalSet';
import { RawCaptureSchema, type RawCapture } from './thresholds/capture/schemas';
import {
  defaultSplit,
  parseHoldoutWeeks,
  splitCapture,
  CASE_STRIDE,
  type Split,
} from './thresholds/split';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

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
    io.stdout(holdoutReport(off, on, keep));
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
