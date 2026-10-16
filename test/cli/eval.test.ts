import { describe, expect, it, vi, type Mock } from 'vitest';
import { assembleMetrics, failedHardGates, type Measurement } from '../../evals/metrics.js';
import { METRIC_IDS, ScorecardSchema, type MetricId, type Scorecard } from '../../evals/schema.js';
import type { DigestDeps } from '../../src/core/runDigest.js';
import { evalCommand, formatScorecard, type EvalCommandIo } from '../../src/cli/eval.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { PROFILES } from '../../src/config/profiles.js';
import type { ProfileName } from '../../src/config/schema.js';
import { DigestError } from '../../src/shared/errors.js';
import { makeConfig } from '../builders.js';
import { fixedClock } from '../fakes/index.js';

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
}

function harness(
  scorecardFor: (profile: ProfileName) => Scorecard = (p) => makeScorecard(p),
  configProfile: ProfileName = 'quality',
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const loaded: LoadedConfig = {
    config: makeConfig({ profile: configProfile }),
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: {},
    profile: PROFILES[configProfile],
    configPath: '/work/digest.config.json',
  };
  const loadConfig = vi.fn<EvalCommandIo['loadConfig']>(() => Promise.resolve(loaded));
  const buildApp = vi.fn<EvalCommandIo['buildApp']>(() =>
    Promise.reject(new Error('buildApp is not called by the fake')),
  );
  const runEval = vi.fn<EvalCommandIo['runEval']>((options) =>
    Promise.resolve(scorecardFor(options.profile)),
  );
  const io: EvalCommandIo = {
    casesDir: 'evals',
    loadConfig,
    buildApp,
    runDigest: () => Promise.reject(new Error('runDigest is not called by the fake')),
    runEval,
    clock: fixedClock('2026-10-16T09:00:00Z'),
    platform: { os: 'darwin', arch: 'arm64' },
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
  return { io, out, err, files, dirs, runEval, loadConfig, buildApp };
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

  it('hands runEval the clock and the digest runner', async () => {
    const h = harness();
    await evalCommand({}, h.io);
    const deps = h.runEval.mock.calls[0]?.[1];
    expect(deps?.clock).toBe(h.io.clock);
    expect(deps?.runDigest).toBe(h.io.runDigest);
  });
});
