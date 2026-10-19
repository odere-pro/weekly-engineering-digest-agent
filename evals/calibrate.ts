// Calibrates the decider's relevance from labeled cases (W11-06):
//   tsx evals/calibrate.ts <raw.json> [--holdout 2026-W40,2026-W41] [--write [--out <file>]]
// Fits on the train split of a raw capture only, measures the holdout split with the file off
// and on, and writes the file only when holdout recall rises and leaks do not. No model calls.
// Without --out the file goes to <dataDir>/eval/calibration/<profile>.json, with the data folder
// (config dataDir) read from digest.config.json only at that moment: a run that writes nothing
// needs no config.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/load';
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
/** Beside the eval checkpoints (`eval/checkpoints`), under the data folder. */
const CALIBRATION_DIR = ['eval', 'calibration'] as const;
const USAGE = [
  'Usage: tsx evals/calibrate.ts <raw.json> [--holdout 2026-W40,2026-W41] [--write [--out <file>]]',
  '  --write saves a kept fit to <dataDir>/eval/calibration/<profile>.json (dataDir from',
  '  digest.config.json); --out <file> saves it there instead.',
  '',
].join('\n');

export interface CalibrateIo {
  casesDir: string;
  /** The data folder (config `dataDir`). Called only to write a kept fit when --out is not given. */
  loadDataDir: () => Promise<string>;
  loadCases: (dir: string) => Promise<EvalCases>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CalibrateIo = {
  casesDir: EVALS_DIR,
  loadDataDir: async () => (await loadConfig()).config.dataDir,
  loadCases: loadEvalCases,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** `--out` as given, else `<dataDir>/eval/calibration/<profile>.json`. */
async function outPathOf(out: unknown, profile: string, io: CalibrateIo): Promise<string> {
  if (typeof out === 'string') return out;
  try {
    return join(await io.loadDataDir(), ...CALIBRATION_DIR, `${profile}.json`);
  } catch (error) {
    throw new Error(
      `cannot get the data folder to write to: ${errorMessage(error)}\nPass --out <file> to choose the file.`,
      { cause: error },
    );
  }
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
    io.stdout(holdoutReport(off, on, keep));
    if (parsed.values.write === true && keep) {
      const out = await outPathOf(parsed.values.out, capture.profile, io);
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
