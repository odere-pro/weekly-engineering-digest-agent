import { describe, expect, it, vi } from 'vitest';
import { makeConfig, makeDraft, makeRunRecord } from '../../test/builders';
import { FakeInputGuard, FakeOutputGuard } from '../../test/fakes';
import { WEEK_40, makeApp, makeDeps, weekItems, type Call } from '../evalKit';
import { replay } from './replay';

const items = weekItems('2026-09-30T09:00:00Z', 'w-');

describe('replay', () => {
  it('runs the digest once as a dry run of the week, with a 7 day window and no fallback', async () => {
    const calls: Call[] = [];
    const app = makeApp();

    await replay(app.deps, makeDeps(app, calls), WEEK_40, items);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({
      dryRun: true,
      weekId: WEEK_40,
      sinceDays: 7,
      noFallback: true,
    });
  });

  it('gives the digest its own deps: recorded items only, no deliveries, its own store', async () => {
    const calls: Call[] = [];
    const app = makeApp();

    await replay(app.deps, makeDeps(app, calls), WEEK_40, items);

    const { deps, collected } = calls[0]!;
    expect(collected.map((item) => item.id).sort()).toEqual(items.map((item) => item.id).sort());
    expect(deps.deliveries).toEqual([]);
    expect(deps.store).not.toBe(app.store);
    expect(deps.config.sources.map((source) => source.id)).toEqual(['feed-a']);
    expect(deps.clock.now().toISOString()).toBe('2026-10-04T23:59:59.999Z');
  });

  it('counts the top 5 and runs every guard, whatever the app config says', async () => {
    const calls: Call[] = [];
    const app = makeApp({
      config: makeConfig({
        topN: 3,
        guards: { input: { enabled: false }, output: { enabled: false } },
      }),
    });

    await replay(app.deps, makeDeps(app, calls), WEEK_40, items);

    const { config } = calls[0]!.deps;
    expect(config.topN).toBe(5);
    expect(config.guards.input.enabled).toBe(true);
    expect(config.guards.output.enabled).toBe(true);
  });

  it('leaves the app it was given as it was', async () => {
    const app = makeApp({ config: makeConfig({ topN: 3 }) });
    const before = { ...app.deps };

    await replay(app.deps, makeDeps(app, []), WEEK_40, items);

    expect(app.deps.config.topN).toBe(3);
    expect(app.deps.deliveries).toBe(before.deliveries);
    expect(app.deps.store).toBe(before.store);
    expect(app.deps.inputGuards).toBe(before.inputGuards);
  });

  it('returns the digest, the run record, the duration and the items it served', async () => {
    const app = makeApp({ config: makeConfig({ maxItemsPerSource: 4 }) });

    const run = await replay(app.deps, makeDeps(app, []), WEEK_40, items);

    expect(run.weekId).toBe(WEEK_40);
    expect(run.markdown).toContain('#');
    expect(run.record.status).toBe('dry-run');
    expect(run.durationMs).toBe(1000);
    expect(run.items).toHaveLength(4);
    expect(run.served.size).toBe(4);
    expect(run.items.every((item) => run.served.has(item.id))).toBe(true);
  });

  it('records the verdict of every input guard on every item it showed', async () => {
    const app = makeApp({
      inputGuards: [
        new FakeInputGuard('clefPolicy', (item) => item.title === 'w-3'),
        new FakeInputGuard('graniteRisk'),
      ],
    });

    const run = await replay(app.deps, makeDeps(app, []), WEEK_40, items);

    expect(run.inputVerdicts).toHaveLength(items.length * 2);
    const flagged = run.inputVerdicts.filter(({ verdict }) => verdict.flagged);
    expect(flagged.map(({ guardId }) => guardId)).toEqual(['clefPolicy']);
  });

  it('asks the model guards about every collected item the run did not show them', async () => {
    const rule = new FakeInputGuard('ruleInjection');
    const clef = new FakeInputGuard('clefPolicy');
    const app = makeApp({ inputGuards: [rule, clef] });
    const onlyRule = makeDeps(
      app,
      [],
      {},
      {
        runDigest: async (deps, options) => {
          for (const item of items) await deps.inputGuards[0]!.checkItem(item);
          return { exitCode: 0, record: makeRunRecord({ runId: options.weekId ?? WEEK_40 }) };
        },
      },
    );

    const run = await replay(app.deps, onlyRule, WEEK_40, items);

    expect(rule.calls).toHaveLength(items.length);
    expect(clef.calls).toHaveLength(items.length);
    expect(run.inputVerdicts).toHaveLength(items.length * 2);
  });

  it('records what the output guards said about each draft', async () => {
    const app = makeApp({ outputGuards: [new FakeOutputGuard('clefRubric', () => true)] });
    const draft = makeDraft([items[0]!]);
    const deps = makeDeps(app, []);
    deps.runDigest = async (replayDeps) => {
      await replayDeps.outputGuards[0]!.checkDraft(draft, []);
      return { record: makeRunRecord({ status: 'dry-run' }), exitCode: 0 };
    };

    const run = await replay(app.deps, deps, WEEK_40, items);

    expect(run.markdown).toBeUndefined();
    expect(run.outputVerdicts).toEqual([
      { draft, verdict: { check: 'clefRubric', flagged: true } },
    ]);
  });

  it('never reports a negative duration', async () => {
    const app = makeApp();
    const deps = makeDeps(app, []);
    const times = [Date.parse('2026-10-16T09:00:10Z'), Date.parse('2026-10-16T09:00:00Z')];
    deps.clock = { now: () => new Date(times.shift() ?? 0) };

    const run = await replay(app.deps, deps, WEEK_40, items);

    expect(run.durationMs).toBe(0);
  });

  it('logs the week it replays', async () => {
    const app = makeApp();
    const info = vi.spyOn(app.deps.logger, 'info').mockImplementation(() => undefined);

    await replay(app.deps, makeDeps(app, []), WEEK_40, items);

    expect(info).toHaveBeenCalledWith('Eval replays a week', { weekId: WEEK_40, items: 6 });
    info.mockRestore();
  });

  it('lets a failing digest run fail the replay', async () => {
    const app = makeApp();
    const deps = makeDeps(app, [], { fail: new Error('model exploded') });

    await expect(replay(app.deps, deps, WEEK_40, items)).rejects.toThrow('model exploded');
  });
});
