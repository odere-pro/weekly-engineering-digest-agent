import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from './rescoreReplay';
import type { Calibration } from '../src/process/calibration';
import type { EvalCases } from './cases/evalSet';
import type { RescoreResult } from './rescore/replay/types';
import { cases } from './rescore/__fixtures__/rescoreKit';

describe('runCli', () => {
  const result: RescoreResult = {
    rescoreWithWriter: false,
    weeks: 1,
    mustIncludeRecall: 1,
    mustExcludeLeaks: 0,
    classifierAccuracy: 0.5,
    secondsPerWeek: 1,
  };
  const calibration: Calibration = {
    version: 1,
    profile: 'light',
    points: [{ raw: 2, calibrated: 2 }],
    areaBias: {},
  };
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    const seen: boolean[] = [];
    return {
      out,
      err,
      seen,
      overrides: {
        casesDir: 'unused',
        loadCases: () => Promise.resolve(cases()),
        run: (_o: unknown, _c: unknown, rescore: boolean) => {
          seen.push(rescore);
          return Promise.resolve(result);
        },
        stdout: (t: string) => out.push(t),
        stderr: (t: string) => err.push(t),
      },
    };
  }

  it('prints the result for --flag on and passes the flag through', async () => {
    const kit = io();

    const code = await runCli(['--profile', 'light', '--flag', 'on'], kit.overrides);

    expect(code).toBe(0);
    expect(kit.seen).toEqual([true]);
    expect(kit.out.join('')).toContain('profile: light');
  });

  it.each([[[]], [['--profile', 'light']], [['--profile', 'nope', '--flag', 'on']], [['--bogus']]])(
    'exits 2 with the usage for %j',
    async (args) => {
      const kit = io();

      expect(await runCli(args, kit.overrides)).toBe(2);
      expect(kit.err.join('')).toContain('Usage');
    },
  );

  it('says why the arguments were refused, then the usage', async () => {
    const kit = io();

    await runCli(['--profile', 'light'], kit.overrides);

    expect(kit.err.join('')).toMatch(
      /^--flag must be on or off\nUsage: tsx evals\/rescoreReplay\.ts/,
    );
    expect(kit.seen).toEqual([]);
  });

  it('loads --calibration and restricts to --holdout weeks', async () => {
    const kit = io();
    const seen: unknown[] = [];

    const code = await runCli(
      ['--profile', 'light', '--flag', 'off', '--calibration', 'c.json', '--holdout', '2026-W40'],
      {
        ...kit.overrides,
        loadCalibration: () => Promise.resolve(calibration),
        run: (o: unknown, c: EvalCases) => {
          seen.push(o, c.weeks.length);
          return Promise.resolve(result);
        },
      },
    );

    expect(code).toBe(0);
    expect(seen).toEqual([
      { profile: 'light', config: undefined, calibration, pairwise: false },
      0,
    ]);
  });

  it('runs on all the cases without --holdout', async () => {
    const kit = io();
    const seen: number[] = [];

    await runCli(['--profile', 'light', '--flag', 'off'], {
      ...kit.overrides,
      run: (_o: unknown, c: EvalCases) => {
        seen.push(c.weeks.length, c.classifier.cases.length);
        return Promise.resolve(result);
      },
    });

    expect(seen).toEqual([1, 2]);
  });

  it('passes --pairwise on through and rejects other values', async () => {
    const kit = io();
    const seen: unknown[] = [];
    const run = (o: unknown) => {
      seen.push(o);
      return Promise.resolve(result);
    };

    expect(
      await runCli(['--profile', 'light', '--flag', 'off', '--pairwise', 'on'], {
        ...kit.overrides,
        run,
      }),
    ).toBe(0);
    expect(seen).toEqual([
      { profile: 'light', config: undefined, calibration: undefined, pairwise: true },
    ]);
    expect(
      await runCli(['--profile', 'light', '--flag', 'off', '--pairwise', 'maybe'], kit.overrides),
    ).toBe(2);
  });

  it('passes --config through', async () => {
    const kit = io();
    const seen: unknown[] = [];

    await runCli(['--profile', 'fast', '--flag', 'off', '--config', 'my.json'], {
      ...kit.overrides,
      run: (o: unknown) => {
        seen.push(o);
        return Promise.resolve(result);
      },
    });

    expect(seen).toEqual([
      { profile: 'fast', config: 'my.json', calibration: undefined, pairwise: false },
    ]);
  });

  it('exits 1 and says why when the run fails', async () => {
    const kit = io();

    const code = await runCli(['--profile', 'light', '--flag', 'off'], {
      ...kit.overrides,
      run: () => Promise.reject(new Error('ollama down')),
    });

    expect(code).toBe(1);
    expect(kit.err.join('')).toContain('ollama down');
    expect(kit.err.join('')).toContain('rescoreReplay failed:');
  });

  it('exits 1 when the cases do not load', async () => {
    const kit = io();

    const code = await runCli(['--profile', 'light', '--flag', 'off'], {
      ...kit.overrides,
      loadCases: () => Promise.reject(new Error('bad case file')),
    });

    expect(code).toBe(1);
    expect(kit.err.join('')).toBe('rescoreReplay failed: bad case file\n');
    expect(kit.out).toEqual([]);
  });

  describe('with the default input and output', () => {
    async function calibrationFile(content: string): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'rescore-'));
      dirs.push(dir);
      const path = join(dir, 'c.json');
      await writeFile(path, content);
      return path;
    }

    it('reads --calibration from the file and checks it', async () => {
      const kit = io();
      const seen: unknown[] = [];
      const path = await calibrationFile(JSON.stringify(calibration));

      const code = await runCli(['--profile', 'light', '--flag', 'off', '--calibration', path], {
        ...kit.overrides,
        run: (o: unknown) => {
          seen.push(o);
          return Promise.resolve(result);
        },
      });

      expect(code).toBe(0);
      expect(seen).toEqual([{ profile: 'light', config: undefined, calibration, pairwise: false }]);
    });

    it('exits 1 for a calibration file that does not match the schema', async () => {
      const kit = io();
      const path = await calibrationFile(JSON.stringify({ version: 2 }));

      const code = await runCli(
        ['--profile', 'light', '--flag', 'off', '--calibration', path],
        kit.overrides,
      );

      expect(code).toBe(1);
      expect(kit.err.join('')).toContain('rescoreReplay failed:');
      expect(kit.seen).toEqual([]);
    });

    it('writes to the process streams', async () => {
      const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const { stdout: _out, stderr: _err, ...rest } = io().overrides;

      const done = await runCli(['--profile', 'light', '--flag', 'off'], rest);
      const usage = await runCli([], rest);

      expect(done).toBe(0);
      expect(usage).toBe(2);
      expect(stdout.mock.calls.flat().join('')).toContain('profile: light');
      expect(stderr.mock.calls.flat().join('')).toContain('Usage: tsx evals/rescoreReplay.ts');
    });
  });
});
