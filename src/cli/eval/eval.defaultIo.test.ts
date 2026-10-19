// `evalCommand` with its real defaults: files on disk, process.stdout and process.stderr, and git.
// Only what the other tests replace is real here; the harness, config and app are still fakes.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScorecardSchema } from '../../../evals/schema';
import type { LoadedConfig } from '../../config/load';
import { PROFILES } from '../../config/profiles';
import { makeConfig } from '../../../test/builders';
import { fixedClock, noopLogger } from '../../../test/fakes';
import { makeScorecard } from './__fixtures__/scorecardKit';
import { evalCommand, type EvalCommandIo } from './eval';

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-command-'));
  tempDirs.push(dir);
  return dir;
}

/** Collects what the command writes to the real stdout and stderr, instead of printing it. */
function captureProcessOutput() {
  const out: string[] = [];
  const err: string[] = [];
  const collect = (into: string[]) => (chunk: string | Uint8Array) => {
    into.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(collect(out));
  vi.spyOn(process.stderr, 'write').mockImplementation(collect(err));
  return { out, err };
}

const LOADED: LoadedConfig = {
  config: makeConfig({ profile: 'light', dataDir: 'data' }),
  env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
  secrets: {},
  profile: PROFILES.light,
  configPath: '/work/digest.config.json',
  platform: { os: 'darwin', arch: 'arm64' },
};

/** The overrides that keep config, app and harness fake, so the defaults left are the real ones. */
function fakeHarness(casesDir: string): Partial<EvalCommandIo> {
  return {
    casesDir,
    createEvalLogger: () => noopLogger,
    loadConfig: () => Promise.resolve(LOADED),
    buildApp: () => Promise.reject(new Error('buildApp is not used: runEval is faked')),
    runEval: () => Promise.resolve(makeScorecard('light')),
    gitSha: () => Promise.resolve('test-sha'),
    checkpointDir: (root, today) => Promise.resolve(`${root}/${today}`),
    clock: fixedClock('2026-10-19T08:00:00Z'),
  };
}

describe('evalCommand: the real defaults', () => {
  it('saves the scorecard under <casesDir>/scorecards, creating the folder', async () => {
    const casesDir = await tempDir();
    const shown = captureProcessOutput();

    const code = await evalCommand({}, { ...fakeHarness(join(casesDir, 'evals')) });

    expect(code).toBe(0);
    const folder = join(casesDir, 'evals', 'scorecards');
    expect(await readdir(folder)).toEqual(['2026-10-16-light.json']);
    const saved = await readFile(join(folder, '2026-10-16-light.json'), 'utf8');
    expect(ScorecardSchema.parse(JSON.parse(saved)).profile).toBe('light');
    expect(saved.endsWith('}\n')).toBe(true);
    expect(shown.out.join('')).toContain('Eval scorecard: light (2026-10-16)');
  });

  it('reads the two scorecards of --compare from disk and prints to stdout', async () => {
    const dir = await tempDir();
    const [a, b] = [join(dir, 'a.json'), join(dir, 'b.json')];
    await writeFile(a, JSON.stringify(makeScorecard('light')), 'utf8');
    await writeFile(b, JSON.stringify(makeScorecard('fast')), 'utf8');
    const shown = captureProcessOutput();

    const code = await evalCommand({ compare: [a, b] }, {});

    expect(code).toBe(0);
    expect(shown.out.join('')).toContain(`A = ${a} (light, 2026-10-16)`);
    expect(shown.err).toEqual([]);
  });

  it('writes an error to stderr and returns its exit code', async () => {
    const shown = captureProcessOutput();
    const missing = join(tmpdir(), 'eval-command-missing.json');

    const code = await evalCommand({ compare: [missing, missing] }, {});

    expect(code).toBe(1);
    expect(shown.err.join('')).toContain(`Cannot read ${missing}`);
    expect(shown.out).toEqual([]);
  });

  describe('the git state that keys the checkpoints', () => {
    /** The commit of this checkout, or undefined outside one. */
    async function headOfCheckout(): Promise<string | undefined> {
      try {
        return (await promisify(execFile)('git', ['rev-parse', 'HEAD'])).stdout.trim();
      } catch {
        return undefined;
      }
    }

    it('is the commit of this checkout, plus a hash of any uncommitted changes', async () => {
      const casesDir = await tempDir();
      captureProcessOutput();
      const head = await headOfCheckout();
      const gitShas: string[] = [];
      const { gitSha: _fake, ...withRealGit } = fakeHarness(casesDir);

      await evalCommand(
        {},
        {
          ...withRealGit,
          runEval: (options) => {
            gitShas.push(options.checkpoints?.gitSha ?? '');
            return Promise.resolve(makeScorecard('light'));
          },
        },
      );

      expect(gitShas).toHaveLength(1);
      // Outside a checkout the value is new every time, so no run can be resumed.
      const expected =
        head === undefined ? /^unknown-\d+$/ : new RegExp(`^${head}(\\+[0-9a-f]{16})?$`);
      expect(gitShas[0]).toMatch(expected);
    });
  });
});
