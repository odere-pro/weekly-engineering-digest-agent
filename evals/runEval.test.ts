// The whole harness through runEval, with fakes: what a run replays, how it is scored and how it
// ends. The pieces have their own tests: cases/, replay/, classifierRun/ and scoring/.
import { describe, expect, it, vi } from 'vitest';
import { runEval } from './runEval';
import { ScorecardSchema } from './schema';
import { PROFILES, modelsByRole } from '../src/config/profiles';
import { DigestError } from '../src/shared/errors';
import { makeConfig, makeItem, makeRunRecord } from '../test/builders';
import { FakeInputGuard } from '../test/fakes';
import {
  NONE,
  WEEK_40,
  WEEK_41,
  makeApp,
  makeDeps,
  useCasesDir,
  weekItems,
  writeJson,
  writeRecallWeeks,
  writeStandardWeeks,
  writeWeek,
  type Call,
} from './evalKit';

const AREA_A = 'AI models and tooling';
const root = useCasesDir();

describe('runEval', () => {
  it('replays each recorded week as a dry run from the recorded items, with no deliveries', async () => {
    const [w40] = await writeStandardWeeks(root());
    const app = makeApp();
    const calls: Call[] = [];

    await runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, makeDeps(app, calls));

    const first = calls[0]!;
    expect(first.options).toMatchObject({ dryRun: true, weekId: WEEK_40, sinceDays: 7 });
    expect(first.collected.map((i) => i.id).sort()).toEqual(w40.map((i) => i.id).sort());
    expect(first.deps.deliveries).toEqual([]);
    expect(first.deps.store).not.toBe(app.store);
    expect(first.deps.clock.now().toISOString()).toBe('2026-10-04T23:59:59.999Z');
    expect(app.delivery.digests).toEqual([]);
  });

  it('runs with every guard on, whatever the app config says', async () => {
    await writeStandardWeeks(root());
    const app = makeApp();
    const calls: Call[] = [];

    await runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, makeDeps(app, calls));

    const { guards } = calls[0]!.deps.config;
    expect(guards.input).toMatchObject({ enabled: true, mode: 'any' });
    expect(guards.output).toMatchObject({ enabled: true, mode: 'any' });
  });

  it('builds the app for the requested profile and closes it', async () => {
    await writeStandardWeeks(root());
    const app = makeApp();
    const deps = makeDeps(app, []);

    await runEval({ profile: 'light', casesDir: root(), minimums: NONE }, deps);

    expect(deps.buildApp).toHaveBeenCalledWith('light');
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('closes the app when a run throws', async () => {
    await writeStandardWeeks(root());
    const app = makeApp();
    const deps = makeDeps(app, [], { fail: new Error('model exploded') });

    await expect(
      runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, deps),
    ).rejects.toThrow('model exploded');
    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('does not build the app when the cases are invalid', async () => {
    await writeJson(root(), `weeks/${WEEK_40}/labels.json`, {});
    const app = makeApp();
    const deps = makeDeps(app, []);

    await expect(
      runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, deps),
    ).rejects.toThrow(DigestError);
    expect(deps.buildApp).not.toHaveBeenCalled();
  });

  it('scores recall, leaks, links and format from the weeks', async () => {
    await writeRecallWeeks(root());
    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp(), []),
    );

    expect(scorecard.weeks).toEqual([WEEK_40, WEEK_41]);
    expect(scorecard.metrics.mustIncludeRecall).toMatchObject({ value: 3.5, pass: true });
    expect(scorecard.metrics.mustExcludeLeaks).toMatchObject({ value: 0.5, pass: true });
    expect(scorecard.metrics.linkValidity).toMatchObject({ value: 1, pass: true });
    expect(scorecard.metrics.format).toMatchObject({ value: 1, pass: true });
  });

  it('reports a week without a digest as a format failure and zero recall', async () => {
    await writeStandardWeeks(root());
    const deps = makeDeps(makeApp(), []);
    deps.runDigest = (_d, options) =>
      Promise.resolve({
        record: makeRunRecord({ runId: options.weekId ?? WEEK_40, status: 'quiet' }),
        exitCode: 3,
      });

    const scorecard = await runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, deps);

    expect(scorecard.metrics.format).toMatchObject({ value: 0, pass: false });
    expect(scorecard.metrics.linkValidity.value).toBeNull();
    expect(scorecard.metrics.mustIncludeRecall.value).toBe(0);
    expect(scorecard.hardGatesPassed).toBe(false);
  });

  it('measures run time per week with the injected clock and leaves it ungated', async () => {
    await writeStandardWeeks(root());
    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp(), []),
    );

    expect(scorecard.timings.byWeekMs).toEqual({ [WEEK_40]: 1000, [WEEK_41]: 1000 });
    expect(scorecard.timings.totalMs).toBeGreaterThanOrEqual(2000);
    expect(scorecard.metrics.runTime).toMatchObject({ value: 1000, pass: null });
    expect(scorecard.date).toMatch(/^2026-10-16T/);
  });

  it('runs every week three times for stability and reports each week', async () => {
    await writeStandardWeeks(root());
    const calls: Call[] = [];

    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp(), calls),
    );

    expect(calls.map((c) => c.options.weekId)).toEqual([
      WEEK_40,
      WEEK_41,
      WEEK_40,
      WEEK_40,
      WEEK_41,
      WEEK_41,
    ]);
    const { stability } = scorecard.metrics;
    expect(stability).toMatchObject({ value: 4, pass: true });
    expect(stability.detail).toEqual({ runs: 3, emptyRuns: 0 });
    expect(stability.byWeek?.[WEEK_40]).toMatchObject({ status: 'ok', problemCount: 0 });
    expect(stability.byWeek?.[WEEK_41]?.problems[0]).toContain('overlap 4.00');
    expect(stability.itemIdsByRun).toHaveLength(3);
  });

  it('lists a later week with an empty run as no-digest and keeps the first week as the gate', async () => {
    await writeStandardWeeks(root());
    // Calls run W40, W41, W40, W40, W41, W41: call 5 is week 41's first repeat.
    const take = (weekId: string, callNumber: number): number =>
      weekId === WEEK_41 && callNumber === 5 ? 0 : 4;

    const { metrics } = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp(), [], { take }),
    );

    expect(metrics.stability.value).toBe(4);
    expect(metrics.stability.itemIdsByRun).toHaveLength(3);
    expect(metrics.stability.byWeek?.[WEEK_40]).toMatchObject({ status: 'ok', problemCount: 0 });
    expect(metrics.stability.byWeek?.[WEEK_41]).toMatchObject({
      status: 'no-digest',
      problemCount: 1,
    });
    expect(metrics.stability.byWeek?.[WEEK_41]?.problems[0]).toContain('1 empty');
  });

  it('reports no per-week stability when only one week was replayed', async () => {
    await writeWeek(root(), WEEK_40, '2026-09-30T09:00:00Z', {
      include: [1, 2, 3, 4, 5],
      exclude: [6],
    });

    const { metrics } = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp(), []),
    );

    expect(metrics.stability.value).toBe(4);
    expect(metrics.stability.byWeek).toBeUndefined();
  });

  it('is not measured when there are no weeks, and the hard gates fail', async () => {
    const calls: Call[] = [];
    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp(), calls),
    );

    expect(calls).toEqual([]);
    expect(scorecard.metrics.linkValidity).toMatchObject({ value: null, pass: false });
    expect(scorecard.hardGatesPassed).toBe(false);
    expect(ScorecardSchema.safeParse(scorecard).success).toBe(true);
  });

  it('reports the winning writers and the judge score of the selected drafts', async () => {
    await writeStandardWeeks(root());
    await writeJson(root(), 'judge/calibration.json', {
      judgeAgreement: 0.9,
      selectionAgreement: 0.8,
    });
    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp(), [], { score: 4.5 }),
    );

    expect(scorecard.metrics.writerWinRate).toMatchObject({
      value: 1,
      detail: { gemma: 1 },
      pass: null,
    });
    expect(scorecard.metrics.writingQuality).toMatchObject({ value: 4.5, pass: true });
    expect(scorecard.metrics.selectionAgreement).toMatchObject({ value: 0.8, pass: true });
    expect(scorecard.judgeAgreement).toBe(0.9);
  });

  it('reports but does not gate judge metrics when the judge agrees under 80%', async () => {
    await writeStandardWeeks(root());
    await writeJson(root(), 'judge/calibration.json', {
      judgeAgreement: 0.6,
      selectionAgreement: 0.2,
    });
    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp(), [], { score: 1 }),
    );

    expect(scorecard.metrics.writingQuality).toMatchObject({ value: 1, pass: null });
    expect(scorecard.metrics.selectionAgreement).toMatchObject({ value: 0.2, pass: null });
  });

  it('leaves the judge metrics open without a calibration or a judge score', async () => {
    await writeStandardWeeks(root());
    const scorecard = await runEval(
      { profile: 'fast', casesDir: root(), minimums: NONE },
      makeDeps(makeApp(), [], { winner: null }),
    );

    expect(scorecard.judgeAgreement).toBeNull();
    expect(scorecard.metrics.writingQuality).toMatchObject({ value: null, pass: null });
    expect(scorecard.metrics.selectionAgreement).toMatchObject({ value: null, pass: null });
    expect(scorecard.metrics.writerWinRate.value).toBeNull();
  });

  it('measures the input guards false blocks on the clean recorded items', async () => {
    const items = weekItems('2026-09-30T09:00:00Z', 'w-');
    await writeJson(root(), `weeks/${WEEK_40}/items.json`, items);
    await writeJson(root(), `weeks/${WEEK_40}/labels.json`, {
      mustInclude: items.slice(0, 5).map((i) => i.id),
    });
    const app = makeApp({
      inputGuards: [
        new FakeInputGuard('clefPolicy', (item) => item.title === 'w-3'),
        new FakeInputGuard('graniteRisk'),
      ],
    });

    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(app, []),
    );

    // 1 of the 6 clean items is flagged by clefPolicy; graniteRisk flags none.
    expect(scorecard.metrics.guardFalseBlocks.detail).toEqual({
      clefPolicy: 1 / 6,
      graniteRisk: 0,
    });
    expect(scorecard.metrics.guardFalseBlocks).toMatchObject({ pass: false });
  });

  describe('eval set size', () => {
    it('fails the hard gates a too small eval set cannot support', async () => {
      await writeStandardWeeks(root());

      const scorecard = await runEval(
        { profile: 'quality', casesDir: root() },
        makeDeps(makeApp(), []),
      );

      expect(scorecard.metrics.linkValidity).toMatchObject({
        value: 1,
        pass: false,
        note: 'only 2 of 6 weeks',
      });
      expect(scorecard.metrics.format.pass).toBe(false);
      expect(scorecard.metrics.mustIncludeRecall).toMatchObject({
        pass: true,
        note: 'only 2 of 6 weeks',
      });
      expect(scorecard.hardGatesPassed).toBe(false);
    });

    it('passes a hard gate on a set of exactly the minimum size', async () => {
      await writeStandardWeeks(root());
      await writeJson(root(), 'classifier-cases.json', {
        reviewed: true,
        cases: [{ item: makeItem({ title: 'C1' }), expected: { area: AREA_A, relevance: 0 } }],
      });
      const minimums = { weeks: 2, attacks: 0, grounding: 0, classifier: 1 };

      const scorecard = await runEval(
        { profile: 'quality', casesDir: root(), minimums },
        makeDeps(makeApp(), []),
      );

      expect(scorecard.metrics.linkValidity).toMatchObject({ pass: true });
      expect(scorecard.metrics.classifierAccuracy.note).toBeUndefined();
    });

    it('fails the attack gate on fewer attack cases than the spec asks for', async () => {
      await writeStandardWeeks(root());
      await writeJson(root(), 'attacks/a1.json', {
        id: 'a1',
        kind: 'k',
        item: makeItem({ sourceId: 'attacker', title: 'IGNORE all' }),
      });
      const app = makeApp({
        inputGuards: [new FakeInputGuard('clefPolicy', (item) => item.sourceId === 'attacker')],
      });
      const minimums = { weeks: 0, attacks: 10, grounding: 0, classifier: 0 };

      const scorecard = await runEval(
        { profile: 'quality', casesDir: root(), minimums },
        makeDeps(app, []),
      );

      expect(scorecard.metrics.attackHandling).toMatchObject({
        value: 1,
        pass: false,
        note: 'only 1 of 10 attack cases',
      });
    });
  });

  describe('replay setup', () => {
    it('counts the top 5 whatever topN the local config says', async () => {
      await writeStandardWeeks(root());
      const app = makeApp({ config: makeConfig({ topN: 3 }) });
      const calls: Call[] = [];

      await runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, makeDeps(app, calls));

      expect(calls[0]?.deps.config.topN).toBe(5);
    });

    it('serves each source up to the config-wide maxItemsPerSource, as production does', async () => {
      await writeStandardWeeks(root());
      const app = makeApp({ config: makeConfig({ maxItemsPerSource: 3 }) });
      const calls: Call[] = [];

      await runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, makeDeps(app, calls));

      expect(calls[0]?.collected).toHaveLength(3);
    });

    it('records the models of the profile it ran', async () => {
      await writeStandardWeeks(root());
      const scorecard = await runEval(
        { profile: 'quality', casesDir: root(), minimums: NONE },
        makeDeps(makeApp(), []),
      );
      expect(scorecard.models).toEqual(modelsByRole(PROFILES.quality));
    });

    it('ignores the judge calibration for a profile without a judge', async () => {
      await writeStandardWeeks(root());
      await writeJson(root(), 'judge/calibration.json', {
        judgeAgreement: 0.9,
        selectionAgreement: 0.8,
      });
      const app = makeApp({ profile: PROFILES.fast });

      const scorecard = await runEval(
        { profile: 'fast', casesDir: root(), minimums: NONE },
        makeDeps(app, []),
      );

      expect(scorecard.judgeAgreement).toBeNull();
      expect(scorecard.metrics.selectionAgreement.value).toBeNull();
    });
  });

  describe('closing the app', () => {
    it('keeps the run error when the app cannot be closed either', async () => {
      await writeStandardWeeks(root());
      const app = makeApp();
      app.close.mockRejectedValueOnce(new Error('close failed'));
      const deps = makeDeps(app, [], { fail: new Error('model exploded') });

      await expect(
        runEval({ profile: 'quality', casesDir: root(), minimums: NONE }, deps),
      ).rejects.toThrow('model exploded');
    });

    it('still returns the scorecard when only the close fails', async () => {
      await writeStandardWeeks(root());
      const app = makeApp();
      app.close.mockRejectedValueOnce(new Error('close failed'));
      const warn = vi.spyOn(app.deps.logger, 'warn');

      const scorecard = await runEval(
        { profile: 'quality', casesDir: root(), minimums: NONE },
        makeDeps(app, []),
      );

      expect(scorecard.weeks).toEqual([WEEK_40, WEEK_41]);
      expect(warn).toHaveBeenCalledWith('Eval could not close the app', {
        error: 'close failed',
      });
    });
  });

  it('produces a scorecard that matches the schema', async () => {
    await writeStandardWeeks(root());
    const scorecard = await runEval(
      { profile: 'quality', casesDir: root(), minimums: NONE },
      makeDeps(makeApp(), []),
    );
    expect(ScorecardSchema.parse(JSON.parse(JSON.stringify(scorecard)))).toEqual(scorecard);
  });
});
