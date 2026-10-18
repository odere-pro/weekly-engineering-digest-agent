// runEval with `only` (partial scorecards) and with checkpoints (resume), no model calls.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SavedScorecardSchema } from './checkpointSections';
import { NONE, makeApp, makeDeps, useCasesDir, writeStandardWeeks, type Call } from './evalKit';
import { runEval } from './runEval';
import { makeConfig } from '../test/builders';

const casesDir = useCasesDir();
const STABILITY_REPLAYS = 3;

async function run(
  options: Parameters<typeof runEval>[0] extends infer O ? Partial<O> : never,
  calls: Call[],
  app = makeApp(),
) {
  return runEval(
    { profile: 'quality', casesDir: casesDir(), minimums: NONE, ...options },
    makeDeps(app, calls),
  );
}

describe('runEval --only', () => {
  it('runs the weeks section only and marks the scorecard partial', async () => {
    await writeStandardWeeks(casesDir());
    const calls: Call[] = [];
    const card = await run({ only: 'weeks' }, calls);
    expect(card.partial).toEqual(['weeks']);
    expect(calls).toHaveLength(2 * STABILITY_REPLAYS);
    expect(card.metrics.linkValidity.value).toBe(1);
    expect(SavedScorecardSchema.parse(card).partial).toEqual(['weeks']);
  });

  it('leaves the other sections unmeasured, with no gate result', async () => {
    await writeStandardWeeks(casesDir());
    const card = await run({ only: 'weeks' }, []);
    for (const id of [
      'classifierAccuracy',
      'sourceParse',
      'attackHandling',
      'groundedness',
    ] as const) {
      expect(card.metrics[id]).toMatchObject({
        value: null,
        pass: null,
        note: 'not run (--only weeks)',
      });
    }
    expect(card.hardGatesPassed).toBe(true);
  });

  it('runs no replay for the sources, classify and guards sections', async () => {
    await writeStandardWeeks(casesDir());
    for (const only of ['sources', 'classify', 'guards'] as const) {
      const calls: Call[] = [];
      const card = await run({ only }, calls);
      expect(calls).toHaveLength(0);
      expect(card.partial).toEqual([only]);
      expect(card.metrics.linkValidity).toMatchObject({ value: null, pass: null });
    }
  });

  it('has no partial marker on a full run', async () => {
    await writeStandardWeeks(casesDir());
    const card = await run({}, []);
    expect(card.partial).toBeUndefined();
  });
});

describe('runEval checkpoints', () => {
  const checkpoints = (resume: boolean, gitSha = 'sha-1') => ({
    dir: join(casesDir(), 'checkpoints'),
    resume,
    gitSha,
  });

  it('writes a checkpoint for each week replay and stability run, and skips them on resume', async () => {
    await writeStandardWeeks(casesDir());
    const first: Call[] = [];
    const before = await run({ only: 'weeks', checkpoints: checkpoints(false) }, first);
    expect(first).toHaveLength(2 * STABILITY_REPLAYS);

    const second: Call[] = [];
    const after = await run({ only: 'weeks', checkpoints: checkpoints(true) }, second);
    expect(second).toHaveLength(0);
    expect(after.metrics).toEqual(before.metrics);
  });

  it('redoes only the replays that are missing', async () => {
    await writeStandardWeeks(casesDir());
    await run({ only: 'weeks', checkpoints: checkpoints(false) }, []);
    const { rm } = await import('node:fs/promises');
    await rm(join(casesDir(), 'checkpoints', 'quality.2026-W41.run2.json'));
    const calls: Call[] = [];
    await run({ only: 'weeks', checkpoints: checkpoints(true) }, calls);
    expect(calls).toHaveLength(1);
  });

  it('redoes everything after a config change', async () => {
    await writeStandardWeeks(casesDir());
    await run({ only: 'weeks', checkpoints: checkpoints(false) }, []);
    const calls: Call[] = [];
    const changed = makeApp({ config: makeConfig({ windowDays: 5 }) });
    await run({ only: 'weeks', checkpoints: checkpoints(true) }, calls, changed);
    expect(calls).toHaveLength(2 * STABILITY_REPLAYS);
  });

  it('redoes everything after a git sha change', async () => {
    await writeStandardWeeks(casesDir());
    await run({ only: 'weeks', checkpoints: checkpoints(false) }, []);
    const calls: Call[] = [];
    await run({ only: 'weeks', checkpoints: checkpoints(true, 'sha-2') }, calls);
    expect(calls).toHaveLength(2 * STABILITY_REPLAYS);
  });
});

describe('runEval replay options', () => {
  it('replays with noFallback so the writers are measured on their own', async () => {
    await writeStandardWeeks(casesDir());
    const calls: Call[] = [];
    await run({ only: 'weeks' }, calls);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.options.noFallback === true)).toBe(true);
  });
});
