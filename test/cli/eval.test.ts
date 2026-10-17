import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { assembleMetrics, failedHardGates, type Measurement } from '../../evals/metrics.js';
import {
  METRIC_IDS,
  ScorecardSchema,
  type MetricId,
  type Scorecard,
  type WeekDetail,
} from '../../evals/schema.js';
import type { DigestDeps } from '../../src/core/runDigest.js';
import { evalCommand, formatScorecard, type EvalCommandIo } from '../../src/cli/eval.js';
import { loadConfig, type LoadedConfig } from '../../src/config/load.js';
import { NON_MAC_FALLBACK, PROFILES, type Platform } from '../../src/config/profiles.js';
import type { ConfigInput, ProfileName } from '../../src/config/schema.js';
import { DigestError } from '../../src/shared/errors.js';
import { makeConfig, makeDraft, makeItem } from '../builders.js';
import { FakeModelProvider, fixedClock } from '../fakes/index.js';

function makeScorecard(
  profile: ProfileName,
  overrides: Partial<Record<MetricId, Measurement>> = {},
  judgeAgreement: number | null = 0.9,
): Scorecard {
  const base = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
    MetricId,
    Measurement
  >;
  const metrics = assembleMetrics({ ...base, ...overrides }, judgeAgreement);
  return {
    profile,
    date: '2026-10-16T09:00:00.000Z',
    weeks: ['2026-W40', '2026-W41'],
    counts: { weeks: 2, classifier: 60, attacks: 10, grounding: 10 },
    judgeAgreement,
    models: { classify: 'clef:latest', judge: null },
    metrics,
    hardGatesPassed: failedHardGates(metrics).length === 0,
    timings: { totalMs: 12_345, byWeekMs: { '2026-W40': 6000, '2026-W41': 6345 } },
  };
}

interface Harness {
  io: EvalCommandIo;
  out: string[];
  err: string[];
  files: Map<string, string>;
  dirs: string[];
  runEval: Mock<EvalCommandIo['runEval']>;
  loadConfig: Mock<EvalCommandIo['loadConfig']>;
  buildApp: Mock<EvalCommandIo['buildApp']>;
  createProvider: Mock<EvalCommandIo['createProvider']>;
}

const CONFIG_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'config');
const VALID_CONFIG = join(CONFIG_FIXTURES, 'valid.config.json');
const MISSING_ENV = join(CONFIG_FIXTURES, 'missing.env');
const MAC: Platform = { os: 'darwin', arch: 'arm64' };
const LINUX: Platform = { os: 'linux', arch: 'x64' };

interface HarnessOptions {
  /**
   * DIGEST_HOST_OS/DIGEST_HOST_ARCH as the loader read them. The loaded config then carries no
   * platform (a config built by hand), so the command must resolve it from this env.
   */
  hostEnv?: Pick<LoadedConfig['env'], 'DIGEST_HOST_OS' | 'DIGEST_HOST_ARCH'>;
  /** The platform the loader resolved the profile for; defaults to a Mac unless `hostEnv` is set. */
  platform?: Platform;
  /** The environment the command sees (EVAL_JUDGE lives here); defaults to an empty one. */
  env?: EvalCommandIo['env'];
  /** Config fields to set besides the profile (model timeouts, retries, focus areas). */
  config?: Partial<ConfigInput>;
}

/** Runs `run` while `process` claims to be `platform`; the real values come back afterwards. */
async function onProcess<T>(platform: Platform, run: () => Promise<T>): Promise<T> {
  const saved = {
    platform: Object.getOwnPropertyDescriptor(process, 'platform'),
    arch: Object.getOwnPropertyDescriptor(process, 'arch'),
  };
  Object.defineProperty(process, 'platform', { value: platform.os, configurable: true });
  Object.defineProperty(process, 'arch', { value: platform.arch, configurable: true });
  try {
    return await run();
  } finally {
    if (saved.platform) Object.defineProperty(process, 'platform', saved.platform);
    if (saved.arch) Object.defineProperty(process, 'arch', saved.arch);
  }
}

function harness(
  scorecardFor: (profile: ProfileName) => Scorecard = (p) => makeScorecard(p),
  configProfile: ProfileName = 'quality',
  options: HarnessOptions = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const loaded: LoadedConfig = {
    config: makeConfig({ ...options.config, profile: configProfile }),
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info', ...options.hostEnv },
    secrets: {},
    profile: PROFILES[configProfile],
    configPath: '/work/digest.config.json',
    ...(options.platform || !options.hostEnv ? { platform: options.platform ?? MAC } : {}),
  };
  const loadConfig = vi.fn<EvalCommandIo['loadConfig']>(() => Promise.resolve(loaded));
  const buildApp = vi.fn<EvalCommandIo['buildApp']>(() =>
    Promise.reject(new Error('buildApp is not called by the fake')),
  );
  const runEval = vi.fn<EvalCommandIo['runEval']>((options) =>
    Promise.resolve(scorecardFor(options.profile)),
  );
  const createProvider = vi.fn<EvalCommandIo['createProvider']>(() => new FakeModelProvider());
  const io: EvalCommandIo = {
    casesDir: 'evals',
    env: options.env ?? {},
    createProvider,
    loadConfig,
    buildApp,
    runDigest: () => Promise.reject(new Error('runDigest is not called by the fake')),
    runEval,
    clock: fixedClock('2026-10-16T09:00:00Z'),
    mkdir: (path) => {
      dirs.push(path);
      return Promise.resolve();
    },
    writeFile: (path, content) => {
      files.set(path, content);
      return Promise.resolve();
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { io, out, err, files, dirs, runEval, loadConfig, buildApp, createProvider };
}

describe('formatScorecard', () => {
  it('prints a table with value, gate and result for every metric', () => {
    const text = formatScorecard(
      makeScorecard('quality', {
        attackHandling: { value: 0.9 },
        guardFalseBlocks: { value: 0.02, detail: { clefPolicy: 0.02, graniteRisk: 0 } },
        mustIncludeRecall: { value: 3.5 },
        runTime: { value: 6172.5, detail: { totalMs: 12_345 } },
        stability: { value: null },
      }),
    );

    expect(text).toContain('quality');
    expect(text).toContain('2026-10-16');
    for (const label of ['Link validity', 'Attack handling', 'Guard false blocks', 'Run time']) {
      expect(text).toContain(label);
    }
    expect(text).toMatch(/Link validity\s+100\.0%\s+hard ≥ 100%\s+PASS/);
    expect(text).toMatch(/Attack handling\s+90\.0%\s+hard ≥ 100%\s+FAIL/);
    expect(text).toMatch(/Guard false blocks\s+2\.0%\s+soft ≤ 5%\s+PASS/);
    expect(text).toMatch(/Must-include recall\s+3\.50\s+soft ≥ 3\s+PASS/);
    expect(text).toMatch(/Stability\s+n\/a\s+soft ≥ 4\s+-/);
    expect(text).toMatch(/Run time\s+6\.2 s\s+reported\s+-/);
    expect(text).toMatch(/Writing quality\s+1\.00\s+soft ≥ 3\.5 \(judge\)\s+FAIL/);
  });

  it('states whether the hard gates passed', () => {
    expect(formatScorecard(makeScorecard('quality'))).toMatch(/Hard gates: PASS/);
    const failing = formatScorecard(makeScorecard('quality', { groundedness: { value: 0.5 } }));
    expect(failing).toMatch(/Hard gates: FAIL \(groundedness\)/);
  });

  it('lists the per-guard details and the notes', () => {
    const text = formatScorecard(
      makeScorecard(
        'light',
        { guardFalseBlocks: { value: 0.1, detail: { clefPolicy: 0.02, graniteRisk: 0.1 } } },
        0.5,
      ),
    );
    expect(text).toContain('clefPolicy=0.02');
    expect(text).toContain('graniteRisk=0.1');
    expect(text).toMatch(/Writing quality: judge agrees 50% of the time.*reported, not gated/);
    expect(text).toMatch(/Writing quality\s+1\.00\s+soft ≥ 3\.5 \(judge\)\s+-/);
  });

  describe('per-week problems', () => {
    const FORMAT_WEEKS: Record<string, WeekDetail> = {
      '2026-W36': { status: 'ok', problems: [], problemCount: 0 },
      '2026-W37': {
        status: 'failed',
        problems: [
          'Item 2 has no "whyItMatters"',
          'Headline is longer than 120 characters',
          'Intro is empty',
          'Item 4 repeats item 1',
          'Item 5 has no url',
        ],
        problemCount: 7,
      },
      '2026-W38': { status: 'no-digest', problems: [], problemCount: 0 },
    };

    const failedWeek = (problems: string[]): WeekDetail => ({
      status: 'failed',
      problems,
      problemCount: problems.length,
    });

    /** The problem lines printed for one failed format week. */
    function printedProblems(problems: string[]): string[] {
      const text = formatScorecard(
        makeScorecard('light', {
          format: { value: 0, byWeek: { '2026-W41': failedWeek(problems) } },
        }),
      );
      return text.split('\n').filter((line) => line.startsWith('    - '));
    }

    it('names every week that failed or produced no digest, with the first problems', () => {
      const text = formatScorecard(
        makeScorecard('light', { format: { value: 0.33, byWeek: FORMAT_WEEKS } }),
      );

      expect(text).toContain('Week problems:');
      expect(text).toContain('  Format 2026-W37: failed, 7 problems');
      expect(text).toContain('    - Item 2 has no "whyItMatters"');
      expect(text).toContain('    - Intro is empty');
      expect(text).toContain('  Format 2026-W38: no digest');
    });

    it('leaves out the weeks that passed and the problems past the first three', () => {
      const text = formatScorecard(
        makeScorecard('light', { format: { value: 0.33, byWeek: FORMAT_WEEKS } }),
      );

      expect(text).not.toContain('2026-W36');
      expect(text).not.toContain('Item 4 repeats item 1');
    });

    it('counts the problems the file dropped as well as the ones it only holds', () => {
      const text = formatScorecard(
        makeScorecard('light', { format: { value: 0.33, byWeek: FORMAT_WEEKS } }),
      );
      // 7 found, 5 kept in the file, 3 printed.
      expect(text).toContain('    ... 4 more (the scorecard file lists the first 5 of 7)');
    });

    it('points to the file when it holds every problem that was not printed', () => {
      const text = formatScorecard(
        makeScorecard('light', {
          format: { value: 0, byWeek: { '2026-W41': failedWeek(['a', 'b', 'c', 'd', 'e']) } },
        }),
      );
      expect(text).toContain('    ... 2 more in the scorecard file');
    });

    it('says "1 problem" for one, and shows no "more" line when all are listed', () => {
      const text = formatScorecard(
        makeScorecard('light', {
          linkValidity: {
            value: 0.5,
            byWeek: {
              '2026-W40 (attacks)': {
                status: 'failed',
                problems: ['https://evil.example/x is not in the sources'],
                problemCount: 1,
              },
            },
          },
        }),
      );

      expect(text).toContain('  Link validity 2026-W40 (attacks): failed, 1 problem');
      expect(text).toContain('    - https://evil.example/x is not in the sources');
      expect(text).not.toContain('more in the scorecard file');
    });

    it('prints a failed week even when its problem list is empty', () => {
      const text = formatScorecard(
        makeScorecard('light', {
          format: {
            value: 0,
            byWeek: { '2026-W41': { status: 'failed', problems: [], problemCount: 0 } },
          },
        }),
      );

      expect(text).toContain('  Format 2026-W41: failed');
      expect(text).not.toContain('0 problems');
    });

    it.each([
      [
        'an escape sequence, newline and tab',
        'bad\nline\u001b[31m red\ttab',
        'bad line [31m red tab',
      ],
      ['a C1 control and DEL', 'a\u009b31mb\u007fc', 'a 31mb c'],
      ['a bidirectional override', 'https://good.example/\u202Eevil', 'https://good.example/ evil'],
      ['a line separator', 'one\u2028two', 'one two'],
      ['zero-width and tag characters', 'a\u200Bb\u{E0041}c', 'a b c'],
      ['a trailing newline', 'text\n', 'text'],
    ])('prints a problem with %s on one clean line', (_name, problem, printed) => {
      expect(printedProblems([problem])).toEqual([`    - ${printed}`]);
    });

    it('cuts a long problem to one short line', () => {
      expect(printedProblems(['x'.repeat(200)])).toEqual([`    - ${'x'.repeat(117)}...`]);
    });

    it('does not split an emoji when it cuts', () => {
      const line = printedProblems([`${'a'.repeat(116)}\u{1F600}tail`])[0] ?? '';
      expect(line).toBe(`    - ${'a'.repeat(116)}...`);
    });

    it('prints no section when every week is fine or the scorecard has no per-week detail', () => {
      const allOk = formatScorecard(
        makeScorecard('light', {
          format: {
            value: 1,
            byWeek: { '2026-W36': { status: 'ok', problems: [], problemCount: 0 } },
          },
        }),
      );

      expect(allOk).not.toContain('Week problems');
      expect(formatScorecard(makeScorecard('light'))).not.toContain('Week problems');
    });
  });

  describe('item ids by run', () => {
    const RUNS = [
      ['a1b2c3d4e5f60718', '1122334455667788'],
      [],
      ['a1b2c3d4e5f60718', '99aabbccddeeff00', '0123456789abcdef'],
    ];

    it('lists each run of the repeated week with its item count and short ids', () => {
      const text = formatScorecard(
        makeScorecard('light', { stability: { value: 0, itemIdsByRun: RUNS } }),
      );

      expect(text).toContain(
        'Item ids by run (first 8 characters; the scorecard file has them in full):',
      );
      expect(text).toContain('  Stability run 1: 2 items: a1b2c3d4 11223344');
      expect(text).toContain('  Stability run 3: 3 items: a1b2c3d4 99aabbcc 01234567');
    });

    it('shows an empty run as "no items", so empty digests differ from different picks', () => {
      const text = formatScorecard(
        makeScorecard('light', { stability: { value: 0, itemIdsByRun: RUNS } }),
      );
      expect(text).toContain('  Stability run 2: no items');
    });

    it('says "1 item" for a single item', () => {
      const text = formatScorecard(
        makeScorecard('light', { stability: { value: 1, itemIdsByRun: [['a1b2c3d4e5f60718']] } }),
      );
      expect(text).toContain('  Stability run 1: 1 item: a1b2c3d4');
    });

    it('shows a link that matched no item as "unmatched", never the URL a model wrote', () => {
      const text = formatScorecard(
        makeScorecard('light', {
          stability: {
            value: 0,
            itemIdsByRun: [['unmatched:https://evil.example/\u202Ex', 'a1b2c3d4e5f60718']],
          },
        }),
      );
      expect(text).toContain('  Stability run 1: 2 items: unmatched a1b2c3d4');
      expect(text).not.toContain('evil.example');
    });

    it('prints an id with a control character on one clean line', () => {
      const text = formatScorecard(
        makeScorecard('light', { stability: { value: 0, itemIdsByRun: [['ab\u001b[31mcdefgh']] } }),
      );
      expect(text).toContain('  Stability run 1: 1 item: ab [31mc');
      expect(text).not.toContain('\u001b');
    });

    it('prints no section for a scorecard without item ids', () => {
      const text = formatScorecard(makeScorecard('light', { stability: { value: 4 } }));
      expect(text).not.toContain('Item ids by run');
    });

    it('keeps the order: details, week problems, item ids, notes, verdict', () => {
      const text = formatScorecard(
        makeScorecard('light', {
          guardFalseBlocks: { value: 0.1, detail: { clefPolicy: 0.1 } },
          format: {
            value: 0,
            byWeek: { '2026-W41': { status: 'no-digest', problems: [], problemCount: 0 } },
          },
          stability: { value: 0, itemIdsByRun: RUNS, note: 'overlap of 3 runs of 2026-W36' },
        }),
      );

      const order = ['Details:', 'Week problems:', 'Item ids by run', 'Notes:', 'Hard gates'].map(
        (heading) => text.indexOf(heading),
      );
      expect(order.every((at) => at >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
  });

  it('shows the judge agreement, or that there is none', () => {
    expect(formatScorecard(makeScorecard('quality'))).toContain('Judge agreement: 90%');
    expect(formatScorecard(makeScorecard('quality', {}, null))).toContain(
      'Judge agreement: not calibrated',
    );
  });
});

describe('evalCommand', () => {
  it('runs the configured profile by default and exits 0 when the hard gates pass', async () => {
    const h = harness();

    const code = await evalCommand({ config: 'digest.config.json' }, h.io);

    expect(code).toBe(0);
    expect(h.runEval).toHaveBeenCalledTimes(1);
    expect(h.runEval.mock.calls[0]?.[0]).toEqual({ profile: 'quality', casesDir: 'evals' });
    expect(h.loadConfig).toHaveBeenCalledWith({ configPath: 'digest.config.json' });
    expect(h.out.join('')).toContain('Link validity');
  });

  it('runs the named profile', async () => {
    const h = harness();
    await evalCommand({ profile: 'light' }, h.io);
    expect(h.runEval.mock.calls.map((c) => c[0].profile)).toEqual(['light']);
  });

  it('runs every profile with --profile all and prints each scorecard', async () => {
    const h = harness();

    const code = await evalCommand({ profile: 'all' }, h.io);

    expect(code).toBe(0);
    expect(h.runEval.mock.calls.map((c) => c[0].profile)).toEqual(['quality', 'fast', 'light']);
    const printed = h.out.join('');
    for (const profile of ['quality', 'fast', 'light']) {
      expect(printed).toContain(`Eval scorecard: ${profile}`);
    }
  });

  it('writes one scorecard file per profile under evals/scorecards', async () => {
    const h = harness();

    await evalCommand({ profile: 'all' }, h.io);

    expect(h.dirs).toContain('evals/scorecards');
    expect([...h.files.keys()]).toEqual([
      'evals/scorecards/2026-10-16-quality.json',
      'evals/scorecards/2026-10-16-fast.json',
      'evals/scorecards/2026-10-16-light.json',
    ]);
    const written = h.files.get('evals/scorecards/2026-10-16-fast.json') ?? '';
    expect(ScorecardSchema.parse(JSON.parse(written)).profile).toBe('fast');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('prints the scorecard even when it cannot be saved', async () => {
    const h = harness();
    h.io.writeFile = () => Promise.reject(new Error('disk full'));

    await expect(evalCommand({}, h.io)).rejects.toThrow('disk full');

    expect(h.out.join('')).toContain('Eval scorecard: quality');
  });

  it('exits 1 when any hard gate fails, and still runs the other profiles', async () => {
    const h = harness((profile) =>
      profile === 'fast'
        ? makeScorecard(profile, { attackHandling: { value: 0.9 } })
        : makeScorecard(profile),
    );

    const code = await evalCommand({ profile: 'all' }, h.io);

    expect(code).toBe(1);
    expect(h.runEval).toHaveBeenCalledTimes(3);
    expect(h.files.size).toBe(3);
  });

  it('exits 1 when a hard gate could not be measured', async () => {
    const h = harness((profile) => makeScorecard(profile, { format: { value: null } }));
    expect(await evalCommand({}, h.io)).toBe(1);
  });

  it('exits 0 when only a soft gate fails', async () => {
    const h = harness((profile) => makeScorecard(profile, { classifierAccuracy: { value: 0.5 } }));
    expect(await evalCommand({}, h.io)).toBe(0);
    expect(h.out.join('')).toMatch(/Classifier accuracy\s+50\.0%\s+soft ≥ 80%\s+FAIL/);
  });

  it('rejects an unknown profile before loading anything', async () => {
    const h = harness();

    const code = await evalCommand({ profile: 'turbo' }, h.io);

    expect(code).toBe(1);
    expect(h.err.join('')).toMatch(/Unknown profile "turbo".*quality, fast, light/);
    expect(h.loadConfig).not.toHaveBeenCalled();
    expect(h.runEval).not.toHaveBeenCalled();
  });

  it('reports a DigestError with its exit code and writes no scorecard', async () => {
    const h = harness();
    h.runEval.mockRejectedValueOnce(
      new DigestError('labels.json: expected 5 items', { exitCode: 1 }),
    );

    const code = await evalCommand({}, h.io);

    expect(code).toBe(1);
    expect(h.err.join('')).toContain('labels.json: expected 5 items');
    expect(h.files.size).toBe(0);
  });

  it('lets unexpected errors through', async () => {
    const h = harness();
    h.runEval.mockRejectedValueOnce(new TypeError('bug'));
    await expect(evalCommand({}, h.io)).rejects.toThrow('bug');
  });

  it('builds the app for each profile from the loaded config', async () => {
    const h = harness();
    h.buildApp.mockResolvedValue({ deps: {} as DigestDeps, close: () => Promise.resolve() });
    h.runEval.mockImplementation(async (options, deps) => {
      await deps.buildApp(options.profile);
      return makeScorecard(options.profile);
    });

    await evalCommand({ profile: 'all' }, h.io);

    const built = h.buildApp.mock.calls.map(([loaded]) => ({
      profile: loaded.config.profile,
      resolved: loaded.profile.name,
      writers: loaded.profile.writers,
    }));
    expect(built).toEqual([
      { profile: 'quality', resolved: 'quality', writers: PROFILES.quality.writers },
      { profile: 'fast', resolved: 'fast', writers: PROFILES.fast.writers },
      { profile: 'light', resolved: 'light', writers: PROFILES.light.writers },
    ]);
  });

  describe('host platform from the environment', () => {
    /** The profile each `--profile all` run was built with, as the loader would hand it to buildApp. */
    async function builtProfiles(h: Harness): Promise<LoadedConfig['profile'][]> {
      h.buildApp.mockResolvedValue({ deps: {} as DigestDeps, close: () => Promise.resolve() });
      h.runEval.mockImplementation(async (options, deps) => {
        await deps.buildApp(options.profile);
        return makeScorecard(options.profile);
      });
      await evalCommand({ profile: 'all' }, h.io);
      return h.buildApp.mock.calls.map(([loaded]) => loaded.profile);
    }

    it('takes DIGEST_HOST_OS/DIGEST_HOST_ARCH over a Linux process, so a container on a Mac gets the tuned profiles', async () => {
      const h = harness(undefined, 'quality', {
        hostEnv: { DIGEST_HOST_OS: 'Darwin', DIGEST_HOST_ARCH: 'aarch64' },
      });

      const built = await onProcess(LINUX, () => builtProfiles(h));

      expect(built).toEqual([PROFILES.quality, PROFILES.fast, PROFILES.light]);
    });

    it('takes the named host over a Mac process: a Linux host gets the untuned fallback', async () => {
      const h = harness(undefined, 'quality', {
        hostEnv: { DIGEST_HOST_OS: 'linux', DIGEST_HOST_ARCH: 'x86_64' },
      });

      const built = await onProcess(MAC, () => builtProfiles(h));

      expect(built).toEqual([
        { ...NON_MAC_FALLBACK, name: 'quality' },
        { ...NON_MAC_FALLBACK, name: 'fast' },
        { ...NON_MAC_FALLBACK, name: 'light' },
      ]);
    });

    it('judges the platform the loader resolved, not one recomputed from the environment', async () => {
      const h = harness(undefined, 'quality', {
        platform: LINUX,
        hostEnv: { DIGEST_HOST_OS: 'darwin', DIGEST_HOST_ARCH: 'arm64' },
      });

      const built = await onProcess(MAC, () => builtProfiles(h));

      expect(built).toEqual([
        { ...NON_MAC_FALLBACK, name: 'quality' },
        { ...NON_MAC_FALLBACK, name: 'fast' },
        { ...NON_MAC_FALLBACK, name: 'light' },
      ]);
    });

    it('uses the running process when no host is named', async () => {
      const h = harness(undefined, 'quality', { hostEnv: {} });

      const built = await onProcess(LINUX, () => builtProfiles(h));

      expect(built.map((profile) => profile.requiresAppleSilicon)).toEqual([false, false, false]);
    });

    it('builds the configured profile for the host the real loader resolved', async () => {
      const h = harness(undefined, 'quality', { hostEnv: {} });
      h.buildApp.mockResolvedValue({ deps: {} as DigestDeps, close: () => Promise.resolve() });
      h.runEval.mockImplementation(async (options, deps) => {
        await deps.buildApp(options.profile);
        return makeScorecard(options.profile);
      });
      const io: EvalCommandIo = {
        ...h.io,
        loadConfig: (options) =>
          loadConfig({
            ...options,
            envPath: MISSING_ENV,
            processEnv: { DIGEST_HOST_OS: 'Darwin', DIGEST_HOST_ARCH: 'arm64' },
          }),
      };

      await onProcess(LINUX, () => evalCommand({ config: VALID_CONFIG }, io));

      expect(h.buildApp.mock.calls.map(([loaded]) => loaded.profile)).toEqual([PROFILES.quality]);
    });

    it('reports a bad value as an error naming the variable, before running anything', async () => {
      const h = harness(undefined, 'quality', { hostEnv: { DIGEST_HOST_ARCH: 'sparc' } });

      const code = await evalCommand({}, h.io);

      expect(code).toBe(1);
      expect(h.err.join('')).toMatch(/DIGEST_HOST_ARCH "sparc"/);
      expect(h.runEval).not.toHaveBeenCalled();
      expect(h.files.size).toBe(0);
    });
  });

  describe('eval judge (EVAL_JUDGE)', () => {
    const JUDGE_TAG = 'clef:latest';

    /** The deps the command handed to runEval on its first call. */
    async function depsFor(h: Harness): Promise<Parameters<EvalCommandIo['runEval']>[1]> {
      await evalCommand({ profile: 'light' }, h.io);
      const deps = h.runEval.mock.calls[0]?.[1];
      if (!deps) throw new Error('runEval was not called');
      return deps;
    }

    it('gives runEval no judge when EVAL_JUDGE is not set', async () => {
      const h = harness();

      const deps = await depsFor(h);

      expect(deps).not.toHaveProperty('judge');
      expect(h.createProvider).not.toHaveBeenCalled();
    });

    it.each([
      ['empty', ''],
      ['blank', '   '],
    ])('gives runEval no judge when EVAL_JUDGE is %s', async (_name, value) => {
      const h = harness(undefined, 'quality', { env: { EVAL_JUDGE: value } });

      const deps = await depsFor(h);

      expect(deps).not.toHaveProperty('judge');
      expect(h.createProvider).not.toHaveBeenCalled();
    });

    it('wires a judge that uses the model named in EVAL_JUDGE', async () => {
      const h = harness(undefined, 'quality', { env: { EVAL_JUDGE: ` ${JUDGE_TAG} ` } });

      const deps = await depsFor(h);

      expect(deps.judge?.model).toBe(JUDGE_TAG);
    });

    it('builds the judge provider from the loaded config, with the judge tag in the profile', async () => {
      // light has no judge of its own: the tag must come from EVAL_JUDGE, or the judge role has no model.
      const tag = 'judge-under-test:1b';
      const h = harness(undefined, 'light', {
        env: { EVAL_JUDGE: tag },
        config: {
          models: { retries: 4, timeoutsMs: { judge: 90_000 }, think: { judge: false } },
        },
      });

      await depsFor(h);

      expect(PROFILES.light.judge).toBeNull();
      expect(h.createProvider).toHaveBeenCalledTimes(1);
      const options = h.createProvider.mock.calls[0]?.[0];
      expect(options).toMatchObject({
        baseUrl: 'http://localhost:11434',
        profile: { ...PROFILES.light, judge: tag },
        timeoutsMs: { judge: 90_000 },
        think: { judge: false },
        retries: 4,
      });
      expect(options?.logger).toBeDefined();
    });

    it('asks the judge role of that provider and turns the levels into a 1-5 score', async () => {
      const provider = new FakeModelProvider({
        decide: (request) =>
          Object.fromEntries(
            Object.keys(request.questions).map((id) => [
              id,
              { type: 'score', level: 3, score: 0.75, probabilities: {}, confidence: 1 } as const,
            ]),
          ),
      });
      const h = harness(undefined, 'quality', {
        env: { EVAL_JUDGE: JUDGE_TAG },
        config: { focusAreas: ['Platform engineering'] },
      });
      h.createProvider.mockReturnValue(provider);
      const items = [makeItem(), makeItem()];

      const deps = await depsFor(h);
      const score = await deps.judge?.score(makeDraft(items, 'gemma4:e4b-mlx'), items);

      expect(provider.decideCalls).toHaveLength(1);
      expect(provider.decideCalls[0]?.role).toBe('judge');
      expect(provider.decideCalls[0]?.questions['focusFit']?.instructions).toContain(
        'Platform engineering',
      );
      expect(score).toEqual({
        writer: 'gemma4:e4b-mlx',
        score: 4,
        byCriterion: { accuracy: 4, clarity: 4, whyItMatters: 4, focusFit: 4 },
      });
    });

    it('builds one judge and hands the same one to every profile of --profile all', async () => {
      const h = harness(undefined, 'quality', { env: { EVAL_JUDGE: JUDGE_TAG } });

      await evalCommand({ profile: 'all' }, h.io);

      expect(h.createProvider).toHaveBeenCalledTimes(1);
      const judges = h.runEval.mock.calls.map(([, deps]) => deps.judge);
      expect(judges).toHaveLength(3);
      expect(judges[0]).toBeDefined();
      expect(new Set(judges).size).toBe(1);
    });

    it('does not build a judge for an unknown profile', async () => {
      const h = harness(undefined, 'quality', { env: { EVAL_JUDGE: JUDGE_TAG } });

      expect(await evalCommand({ profile: 'turbo' }, h.io)).toBe(1);

      expect(h.createProvider).not.toHaveBeenCalled();
    });

    it('reads the process environment by default', async () => {
      vi.stubEnv('EVAL_JUDGE', JUDGE_TAG);
      try {
        const { env: _env, createProvider: _factory, ...io } = harness().io;
        const tags: (string | null | undefined)[] = [];

        await evalCommand(
          {},
          {
            ...io,
            createProvider: (options) => {
              tags.push(options.profile.judge);
              return new FakeModelProvider();
            },
          },
        );

        expect(tags).toEqual([JUDGE_TAG]);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it('hands runEval the clock and the digest runner', async () => {
    const h = harness();
    await evalCommand({}, h.io);
    const deps = h.runEval.mock.calls[0]?.[1];
    expect(deps?.clock).toBe(h.io.clock);
    expect(deps?.runDigest).toBe(h.io.runDigest);
  });
});
