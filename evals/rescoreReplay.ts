// Measures whether rescoring the filtered items with the writer model helps (W6-08):
//   tsx evals/rescoreReplay.ts --profile light --flag on|off [--config <digest.config.json>]
//     [--calibration <file>] [--holdout 2026-W40,2026-W41]
// Replays classify and select over the recorded weeks (no write, no guards, the same per-source
// cap `runEval` serves) and the classifier cases; prints must-include recall, must-exclude
// leaks and classifier accuracy.
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CalibrationSchema, type Calibration } from '../src/process/calibration';
import { errorMessage } from '../src/shared/errors';
import { loadEvalCases } from './cases/loadEvalCases';
import type { EvalCases } from './cases/evalSet';
import { parseCli, USAGE } from './rescore/cli/parseCli';
import { runWithApp, type RunOptions } from './rescore/cli/runWithApp';
import { holdoutOf } from './rescore/holdout/holdoutOf';
import type { RescoreResult } from './rescore/replay/types';
import { formatResult } from './rescore/report/formatResult';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const EVALS_DIR = fileURLToPath(new URL('.', import.meta.url));

export interface RescoreCliIo {
  casesDir: string;
  run: (options: RunOptions, cases: EvalCases, rescore: boolean) => Promise<RescoreResult>;
  loadCases: (dir: string) => Promise<EvalCases>;
  loadCalibration: (path: string) => Promise<Calibration>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: RescoreCliIo = {
  casesDir: EVALS_DIR,
  run: runWithApp,
  loadCases: loadEvalCases,
  loadCalibration: async (path) =>
    CalibrationSchema.parse(JSON.parse(await readFile(path, 'utf8'))),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** Returns the exit code: 0 done, 1 failed, 2 usage. */
export async function runCli(
  args: readonly string[],
  overrides: Partial<RescoreCliIo> = {},
): Promise<number> {
  const io: RescoreCliIo = { ...defaultIo, ...overrides };
  const parsed = parseCli(args);
  if (!parsed.ok) {
    io.stderr(`${parsed.reason}\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    const all = await io.loadCases(io.casesDir);
    const cases = parsed.holdout ? holdoutOf(all, parsed.holdout) : all;
    const calibration =
      parsed.calibration === undefined ? undefined : await io.loadCalibration(parsed.calibration);
    const result = await io.run(
      { profile: parsed.profile, config: parsed.config, calibration, pairwise: parsed.pairwise },
      cases,
      parsed.flag,
    );
    io.stdout(formatResult(parsed.profile, result));
    return EXIT_OK;
  } catch (error) {
    io.stderr(`rescoreReplay failed: ${errorMessage(error)}\n`);
    return EXIT_FAILED;
  }
}

// realpath: node resolves symlinks for the entry module, so argv[1] must be resolved the same way.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
