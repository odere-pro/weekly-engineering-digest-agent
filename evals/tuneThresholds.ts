// Tunes minRelevance, maxHype, maxMinorRelease and guardFlag for one profile (W3-03).
// `capture` calls the models once and saves their raw outputs; `sweep` picks the thresholds from
// those outputs offline, with no model calls:
//   tsx evals/tuneThresholds.ts capture [--config <digest config file>]
//   tsx evals/tuneThresholds.ts sweep evals/thresholds/raw/<date>-light.json
// `capture` builds the app from a digest config file (default digest.config.json) and captures the
// `profile` set in it. To capture another profile, pass a copy of the config with that profile
// (a recipe is in evals/thresholds/README.md).
// This file is the command line only; the work is in evals/thresholds/ (see its CLAUDE.md).
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildApp } from '../src/app/container';
import { loadConfig } from '../src/config/load';
import { systemClock } from '../src/shared/clock';
import { errorMessage } from '../src/shared/errors';
import { loadEvalCases } from './cases/loadEvalCases';
import { captureCommand, type CaptureOptions } from './thresholds/cli/captureCommand';
import { EXIT_FAILED, EXIT_USAGE, type CaptureSession, type CliIo } from './thresholds/cli/io';
import { captureSession } from './thresholds/cli/session';
import { sweepCommand } from './thresholds/cli/sweepCommand';
import { parseHoldoutWeeks } from './thresholds/split';

const USAGE = [
  'Usage:',
  '  tsx evals/tuneThresholds.ts capture [--config <digest.config.json>] [--force]',
  '  tsx evals/tuneThresholds.ts sweep <evals/thresholds/raw/<date>-<profile>.json> [--holdout <weeks>]',
  '    --holdout: comma-separated week ids kept out of the pick (default: the two newest weeks)',
  '',
].join('\n');

const openCapture = async (configPath: string | undefined): Promise<CaptureSession> =>
  captureSession(await buildApp(await loadConfig({ configPath })));

const EVALS_DIR = fileURLToPath(new URL('.', import.meta.url));

const defaultIo: CliIo = {
  casesDir: EVALS_DIR,
  outDir: join(EVALS_DIR, 'thresholds'),
  openCapture,
  loadEvalSet: loadEvalCases,
  clock: systemClock,
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

type Command =
  | ({ name: 'capture' } & CaptureOptions)
  | { name: 'sweep'; rawPath: string; holdout: string[] | undefined }
  | { name: 'usage'; reason?: string };

function sweepOf(rawPath: string, holdout: string | undefined): Command {
  try {
    return {
      name: 'sweep',
      rawPath,
      holdout: holdout === undefined ? undefined : parseHoldoutWeeks(holdout),
    };
  } catch (error) {
    return { name: 'usage', reason: errorMessage(error) };
  }
}

function parseCommand(args: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        force: { type: 'boolean', default: false },
        holdout: { type: 'string' },
      },
    });
  } catch (error) {
    return { name: 'usage', reason: errorMessage(error) };
  }
  const [name, rawPath, ...extra] = parsed.positionals;
  if (extra.length > 0) return { name: 'usage', reason: `unexpected ${extra.join(' ')}` };
  if (name === 'capture' && rawPath === undefined && parsed.values.holdout !== undefined)
    return { name: 'usage', reason: '--holdout belongs to sweep' };
  if (name === 'capture' && rawPath === undefined)
    return { name, config: parsed.values.config, force: parsed.values.force };
  if (name === 'sweep' && rawPath !== undefined) return sweepOf(rawPath, parsed.values.holdout);
  return { name: 'usage' };
}

/** `capture` or `sweep`. Returns the exit code: 0 done, 1 failed, 2 usage. */
export async function runCli(
  args: readonly string[],
  overrides: Partial<CliIo> = {},
): Promise<number> {
  const io: CliIo = { ...defaultIo, ...overrides };
  const command = parseCommand(args);
  if (command.name === 'usage') {
    io.stderr(`${command.reason === undefined ? '' : `${command.reason}\n`}${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    return command.name === 'capture'
      ? await captureCommand(command, io)
      : await sweepCommand(command.rawPath, command.holdout, io);
  } catch (error) {
    io.stderr(`tuneThresholds failed: ${errorMessage(error)}\n`);
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
