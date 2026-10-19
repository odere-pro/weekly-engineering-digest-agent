// `digest eval --only`, `--resume` and `--compare` (W11-08): what the command passes to the harness,
// what it saves and what exit code it returns. No model, no network, no real files.
import { describe, expect, it, vi } from 'vitest';
import { assembleMetrics, failedHardGates } from '../../../evals/metrics';
import { type Measurement } from '../../../evals/metrics/measurement/measurement';
import { METRIC_IDS, type MetricId } from '../../../evals/schema';
import type { SavedScorecard } from '../../../evals/checkpointSections';
import type { LoadedConfig } from '../../config/load';
import { PROFILES } from '../../config/profiles';
import { makeConfig } from '../../../test/builders';
import { fixedClock, noopLogger } from '../../../test/fakes';
import { evalCommand, type EvalCommandIo } from './eval';

function scorecard(
  overrides: Partial<Record<MetricId, Measurement>> = {},
  extra: { partial?: SavedScorecard['partial']; date?: string; weekStatus?: 'ok' | 'failed' } = {},
): SavedScorecard {
  const base = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
    MetricId,
    Measurement
  >;
  const status = extra.weekStatus ?? 'ok';
  const format: Measurement = {
    value: 1,
    byWeek: { '2026-W40': { status, problems: [], problemCount: status === 'ok' ? 0 : 1 } },
  };
  const metrics = assembleMetrics({ ...base, format, ...overrides }, 0.9);
  return {
    profile: 'light',
    date: extra.date ?? '2026-10-16T09:00:00.000Z',
    weeks: ['2026-W40'],
    counts: { weeks: 1, classifier: 1, attacks: 1, grounding: 1 },
    judgeAgreement: 0.9,
    models: {},
    metrics,
    hardGatesPassed: failedHardGates(metrics).length === 0,
    timings: { totalMs: 1, byWeekMs: {} },
    ...(extra.partial ? { partial: extra.partial } : {}),
  };
}

function setup(card: SavedScorecard = scorecard(), files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  const loaded: LoadedConfig = {
    config: makeConfig({ profile: 'light', dataDir: 'data' }),
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: {},
    profile: PROFILES.light,
    configPath: '/work/digest.config.json',
    platform: { os: 'darwin', arch: 'arm64' },
  };
  const runEval = vi.fn<EvalCommandIo['runEval']>(() => Promise.resolve(card));
  const checkpointDir = vi.fn<EvalCommandIo['checkpointDir']>((root, today) =>
    Promise.resolve(`${root}/${today}`),
  );
  const io: Partial<EvalCommandIo> = {
    casesDir: 'evals',
    createEvalLogger: () => noopLogger,
    loadConfig: () => Promise.resolve(loaded),
    buildApp: () => Promise.reject(new Error('buildApp is not used: runEval is faked')),
    runEval,
    gitSha: () => Promise.resolve('abc123'),
    checkpointDir,
    readFile: (path) => {
      const text = files[path];
      return text === undefined ? Promise.reject(new Error(`no ${path}`)) : Promise.resolve(text);
    },
    clock: fixedClock('2026-10-19T08:00:00Z'),
    mkdir: () => Promise.resolve(),
    writeFile: (path, content) => {
      written.set(path, content);
      return Promise.resolve();
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  };
  return { io, out, err, written, runEval, checkpointDir };
}

describe('digest eval --only', () => {
  it('passes the section and the checkpoint settings to the harness', async () => {
    const t = setup(scorecard({}, { partial: ['guards'] }));
    await evalCommand({ only: 'guards', resume: true }, t.io);
    expect(t.runEval.mock.calls[0]?.[0]).toMatchObject({
      only: 'guards',
      checkpoints: { dir: 'data/eval/checkpoints/2026-10-19', resume: true, gitSha: 'abc123' },
    });
    expect(t.checkpointDir).toHaveBeenCalledWith('data/eval/checkpoints', '2026-10-19', true);
  });

  it('passes no section on a full run', async () => {
    const t = setup();
    await evalCommand({}, t.io);
    expect(t.runEval.mock.calls[0]?.[0]).not.toHaveProperty('only');
  });

  it('exits 0 on a partial scorecard even when a hard gate failed, and says it is partial', async () => {
    const card = scorecard({ attackHandling: { value: 0.5 } }, { partial: ['guards'] });
    expect(failedHardGates(card.metrics)).toContain('attackHandling');
    const t = setup(card);
    expect(await evalCommand({ only: 'guards' }, t.io)).toBe(0);
    expect(t.out.join('')).toContain('Partial run: guards');
    expect(t.out.join('')).toContain('Hard gates: FAIL');
  });

  it('exits 1 when a hard gate fails on a full run', async () => {
    const t = setup(scorecard({ attackHandling: { value: 0.5 } }));
    expect(await evalCommand({}, t.io)).toBe(1);
  });

  it('saves a partial scorecard under its own name, with the marker', async () => {
    const t = setup(scorecard({}, { partial: ['classify'] }));
    await evalCommand({ only: 'classify' }, t.io);
    const [path, content] = [...t.written][0] ?? [];
    expect(path).toBe('evals/scorecards/2026-10-16-light-partial-classify.json');
    expect((JSON.parse(content ?? '') as { partial: string[] }).partial).toEqual(['classify']);
  });

  it('rejects an unknown section before running anything', async () => {
    const t = setup();
    expect(await evalCommand({ only: 'everything' }, t.io)).toBe(1);
    expect(t.err.join('')).toContain(
      'Unknown section "everything". Use guards, classify, sources, weeks.',
    );
    expect(t.runEval).not.toHaveBeenCalled();
  });
});

describe('digest eval --compare', () => {
  const a = JSON.stringify(
    scorecard({ classifierAccuracy: { value: 0.7 } }, { weekStatus: 'failed' }),
  );
  const b = JSON.stringify(
    scorecard({ classifierAccuracy: { value: 0.85 } }, { date: '2026-10-18T09:00:00.000Z' }),
  );

  it('prints every metric with both values, the delta and the gate, then the changed weeks', async () => {
    const t = setup(scorecard(), { 'a.json': a, 'b.json': b });
    expect(await evalCommand({ compare: ['a.json', 'b.json'] }, t.io)).toBe(0);
    const text = t.out.join('');
    expect(text).toContain('A = a.json');
    expect(text).toContain('B = b.json');
    for (const id of METRIC_IDS) expect(text).toContain(scorecard().metrics[id].label);
    expect(text).toMatch(
      /Classifier accuracy\s+70\.0%\s+85\.0%\s+\+15\.0 pt\s+soft ≥ 80%\s+FAIL -> PASS/,
    );
    expect(text).toMatch(/Weeks that changed status:/);
    expect(text).toMatch(/Format\s+2026-W40\s+failed\s+ok/);
    expect(t.runEval).not.toHaveBeenCalled();
  });

  it('says so when no week changed', async () => {
    const t = setup(scorecard(), { 'a.json': b, 'b.json': b });
    await evalCommand({ compare: ['a.json', 'b.json'] }, t.io);
    expect(t.out.join('')).toContain('no week changed status');
  });

  it('notes a partial scorecard', async () => {
    const partial = JSON.stringify(scorecard({}, { partial: ['weeks'] }));
    const t = setup(scorecard(), { 'a.json': partial, 'b.json': b });
    await evalCommand({ compare: ['a.json', 'b.json'] }, t.io);
    expect(t.out.join('')).toContain('A partial scorecard');
  });

  it('names a file it cannot read', async () => {
    const t = setup(scorecard(), { 'b.json': b });
    expect(await evalCommand({ compare: ['gone.json', 'b.json'] }, t.io)).toBe(1);
    expect(t.err.join('')).toContain('Cannot read gone.json');
  });

  it('needs exactly two files', async () => {
    const t = setup();
    expect(await evalCommand({ compare: ['a.json'] }, t.io)).toBe(1);
    expect(t.err.join('')).toContain('--compare needs two scorecard files');
  });

  it('reports a file that is not a scorecard', async () => {
    const t = setup(scorecard(), { 'a.json': '{}', 'b.json': b });
    expect(await evalCommand({ compare: ['a.json', 'b.json'] }, t.io)).toBe(1);
    expect(t.err.join('')).toContain('a.json is not a scorecard');
  });
});
