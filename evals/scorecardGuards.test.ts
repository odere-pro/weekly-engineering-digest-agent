// W11-01: the guards measured on the real recorded weeks, per-guard recall that does not depend
// on guard order, and the cause of a week without a digest.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assembleMetrics,
  formatCompliance,
  guardAttackRecall,
  guardRealBlocks,
  noDigestCause,
  type AttackOutcome,
  type ReplayEnd,
} from './metrics';
import { METRIC_IDS, ScorecardSchema, type MetricId } from './schema';
import { runEval, type EvalDeps } from './runEval';
import {
  WEEK_40,
  fakeRunDigest,
  makeApp,
  makeDeps,
  useCasesDir,
  writeJson,
  writeStandardWeeks,
  type Call,
} from './evalKit';
import type { Draft, Item } from '../src/domain/schemas';
import type { GuardCheckId, GuardVerdict } from '../src/guards/guardVerdict';
import type { OutputGuard } from '../src/guards/Guard';
import { makeDraft, makeItem, makeRunRecord } from '../test/builders';
import { FakeInputGuard } from '../test/fakes';

const draftOutcome = (rejectedBy: string[]) => ({ writer: 'gemma', passed: false, rejectedBy });

const blockedEnd = (label: string, rejectedBy: string[][], reason?: string): ReplayEnd => ({
  label,
  status: 'blocked',
  drafts: rejectedBy.map(draftOutcome),
  outputVerdicts: rejectedBy.flatMap((ids) =>
    ids
      .filter((id) => id.startsWith('granite') || id.startsWith('clef'))
      .map((id) => ({
        check: id as GuardCheckId,
        flagged: true,
        ...(reason === undefined ? {} : { reason }),
      })),
  ),
});

const okEnd = (label: string): ReplayEnd => ({
  label,
  status: 'dry-run',
  drafts: [{ writer: 'gemma', passed: true, rejectedBy: [] }],
  outputVerdicts: [],
});

describe('guardRealBlocks', () => {
  it('counts a replay where an output guard rejected every draft, with its reason', () => {
    const measurement = guardRealBlocks([
      okEnd('2026-W36'),
      blockedEnd('2026-W36', [['graniteGroundedness']], 'claim not in source'),
      okEnd('2026-W36'),
    ]);

    expect(measurement.value).toBeCloseTo(1 / 3);
    expect(measurement.detail).toMatchObject({
      runs: 3,
      blockedRuns: 1,
      graniteGroundedness: 1 / 3,
      clefRubric: 0,
    });
    expect(measurement.byWeek?.['2026-W36 (2)']).toEqual({
      status: 'failed',
      problems: ['blocked by graniteGroundedness: claim not in source'],
      problemCount: 1,
    });
    expect(measurement.byWeek?.['2026-W36']?.status).toBe('ok');
  });

  it('does not count a run rejected by the link check as a guard block', () => {
    const measurement = guardRealBlocks([blockedEnd('2026-W37', [['linkCheck']]), okEnd('x')]);

    expect(measurement.value).toBe(0);
    expect(measurement.byWeek?.['2026-W37']?.status).toBe('ok');
  });

  it('counts a draft rejected by a guard and the link check together', () => {
    const measurement = guardRealBlocks([blockedEnd('w', [['linkCheck', 'clefRubric']], 'bad')]);
    expect(measurement.value).toBe(1);
  });

  it('is not a guard block when one draft was rejected by a check only', () => {
    const measurement = guardRealBlocks([
      blockedEnd('w', [['graniteGroundedness'], ['linkCheck']]),
    ]);
    expect(measurement.value).toBe(0);
  });

  it('cuts a long reason short and handles a missing one', () => {
    const long = guardRealBlocks([blockedEnd('w', [['clefRubric']], 'x'.repeat(500))]);
    expect(long.byWeek?.w?.problems[0]?.length).toBeLessThan(260);
    const none = guardRealBlocks([blockedEnd('w', [['clefRubric']])]);
    expect(none.byWeek?.w?.problems).toEqual(['blocked by clefRubric']);
  });

  it('is null without replays', () => {
    expect(guardRealBlocks([]).value).toBeNull();
  });
});

describe('noDigestCause', () => {
  it('names the guard that blocked the run', () => {
    expect(noDigestCause(blockedEnd('w', [['graniteGroundedness']]))).toBe(
      'blocked by graniteGroundedness',
    );
  });
  it('names the check that rejected the run', () => {
    expect(noDigestCause(blockedEnd('w', [['linkCheck']]))).toBe('rejected by linkCheck');
  });
  it('names both when both rejected', () => {
    expect(noDigestCause(blockedEnd('w', [['clefRubric'], ['formatCheck']]))).toBe(
      'blocked by clefRubric; rejected by formatCheck',
    );
  });
  it('falls back to the run status', () => {
    expect(noDigestCause({ ...okEnd('w'), status: 'quiet', drafts: [] })).toBe(
      'run ended as "quiet"',
    );
    expect(noDigestCause({ ...okEnd('w'), status: 'blocked', drafts: [] })).toBe(
      'run ended as "blocked"',
    );
  });
});

describe('formatCompliance names the cause of a week without a digest', () => {
  it('puts the cause in the problems', () => {
    const measurement = formatCompliance([
      { weekId: '2026-W36', markdown: undefined, items: [], cause: 'blocked by clefRubric' },
      { weekId: '2026-W37', markdown: undefined, items: [] },
    ]);
    expect(measurement.byWeek?.['2026-W36']).toEqual({
      status: 'no-digest',
      problems: ['blocked by clefRubric'],
      problemCount: 1,
    });
    expect(measurement.byWeek?.['2026-W37']).toEqual({
      status: 'no-digest',
      problems: [],
      problemCount: 0,
    });
  });
});

describe('guardAttackRecall on its own', () => {
  const outcome = (
    caseId: string,
    blockedBy: GuardCheckId[],
    flaggedAlone?: GuardCheckId[],
  ): AttackOutcome => ({
    caseId,
    reachedDigest: false,
    evaluated: true,
    blockedBy,
    ...(flaggedAlone === undefined ? {} : { flaggedAlone }),
  });

  it('counts what each guard flags even when an earlier guard flagged the item too', () => {
    const measurement = guardAttackRecall(
      [
        outcome('a1', ['clefPolicy'], ['clefPolicy', 'graniteRisk']),
        outcome('a2', ['clefPolicy'], ['clefPolicy']),
        outcome('a3', [], []),
      ],
      [],
      ['clefPolicy', 'graniteRisk'],
    );
    expect(measurement.value).toBeCloseTo(2 / 3);
    expect(measurement.detail).toEqual({ clefPolicy: 2, graniteRisk: 1 });
  });

  it('falls back to the blocking guards when no independent run was made', () => {
    const measurement = guardAttackRecall(
      [outcome('a1', ['clefPolicy'])],
      [],
      ['clefPolicy', 'graniteRisk'],
    );
    expect(measurement.detail).toEqual({ clefPolicy: 1, graniteRisk: 0 });
  });
});

describe('the new metric in the scorecard', () => {
  it('has a soft gate of at most 5%', () => {
    expect(METRIC_IDS).toContain('guardRealBlocks');
    const all = Object.fromEntries(METRIC_IDS.map((id) => [id, { value: 1 }])) as Record<
      MetricId,
      { value: number }
    >;
    const metrics = assembleMetrics({ ...all, guardRealBlocks: { value: 0.06 } }, null);
    expect(metrics.guardRealBlocks).toMatchObject({
      gate: { kind: 'soft', direction: 'atMost', threshold: 0.05 },
      pass: false,
    });
    expect(
      assembleMetrics({ ...all, guardRealBlocks: { value: 0.05 } }, null).guardRealBlocks.pass,
    ).toBe(true);
  });
});

describe('runEval with guards on the real weeks', () => {
  const casesDir = useCasesDir();

  /** An output guard that flags drafts on the listed calls (1-based) and says why. */
  class ReasonGuard implements OutputGuard {
    calls = 0;
    constructor(
      readonly id: GuardCheckId,
      private readonly flagOn: readonly number[],
    ) {}
    checkDraft(_draft: Draft): Promise<GuardVerdict> {
      this.calls += 1;
      const flagged = this.flagOn.includes(this.calls);
      return Promise.resolve({
        check: this.id,
        flagged,
        ...(flagged ? { reason: 'summary claims a speedup the source does not state' } : {}),
      });
    }
  }

  /** The canned runDigest, except that the nth run is blocked by the output guards or the link check. */
  function blockingRunDigest(
    calls: Call[],
    blockRun: number,
    rejectedBy: 'guard' | 'link',
  ): EvalDeps['runDigest'] {
    const inner = fakeRunDigest(calls);
    let run = 0;
    return async (deps, options) => {
      run += 1;
      const result = await inner(deps, options);
      if (run !== blockRun) return result;
      const draft = makeDraft([makeItem()]);
      for (const guard of deps.outputGuards) await guard.checkDraft(draft, []);
      return {
        record: makeRunRecord({
          runId: options.weekId ?? WEEK_40,
          status: 'blocked',
          dryRun: true,
          drafts: [
            {
              writer: 'gemma',
              passed: false,
              rejectedBy: rejectedBy === 'guard' ? ['graniteGroundedness'] : ['linkCheck'],
            },
          ],
        }),
        exitCode: 2,
      };
    };
  }

  it('measures the replay that an output guard blocked, with its reason', async () => {
    await writeStandardWeeks(casesDir());
    const guard = new ReasonGuard('graniteGroundedness', [1]);
    const app = makeApp({ outputGuards: [guard] });
    const calls: Call[] = [];
    const scorecard = await runEval(
      {
        profile: 'quality',
        casesDir: casesDir(),
        minimums: { weeks: 0, attacks: 0, grounding: 0, classifier: 0 },
      },
      makeDeps(app, calls, {}, { runDigest: blockingRunDigest(calls, 2, 'guard') }),
    );

    // 2 weeks x 3 runs = 6 replays; the second one (W40 run 1... in replay order) is blocked.
    const metric = scorecard.metrics.guardRealBlocks;
    expect(metric.value).toBeCloseTo(1 / 6);
    expect(metric.pass).toBe(false);
    const blocked = Object.entries(metric.byWeek ?? {}).filter(([, d]) => d.status === 'failed');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.[1].problems[0]).toBe(
      'blocked by graniteGroundedness: summary claims a speedup the source does not state',
    );
    // The blocked week has no digest: the format metric names why.
    const noDigest = Object.values(scorecard.metrics.format.byWeek ?? {}).filter(
      (d) => d.status === 'no-digest',
    );
    expect(noDigest.map((d) => d.problems)).toEqual([['blocked by graniteGroundedness']]);
  });

  it('does not count a run rejected by the link check', async () => {
    await writeStandardWeeks(casesDir());
    const app = makeApp({ outputGuards: [new ReasonGuard('graniteGroundedness', [])] });
    const calls: Call[] = [];
    const scorecard = await runEval(
      {
        profile: 'quality',
        casesDir: casesDir(),
        minimums: { weeks: 0, attacks: 0, grounding: 0, classifier: 0 },
      },
      makeDeps(app, calls, {}, { runDigest: blockingRunDigest(calls, 1, 'link') }),
    );

    expect(scorecard.metrics.guardRealBlocks.value).toBe(0);
    const causes = Object.values(scorecard.metrics.format.byWeek ?? {}).flatMap((d) => d.problems);
    expect(causes).toContain('rejected by linkCheck');
  });

  it('names the cause in the stability detail of a week with an empty run', async () => {
    await writeStandardWeeks(casesDir());
    const app = makeApp({ outputGuards: [new ReasonGuard('graniteGroundedness', [1])] });
    const calls: Call[] = [];
    const scorecard = await runEval(
      {
        profile: 'quality',
        casesDir: casesDir(),
        minimums: { weeks: 0, attacks: 0, grounding: 0, classifier: 0 },
      },
      makeDeps(app, calls, {}, { runDigest: blockingRunDigest(calls, 2, 'guard') }),
    );

    const entries = Object.values(scorecard.metrics.stability.byWeek ?? {});
    const emptied = entries.find((d) => d.status === 'no-digest');
    expect(emptied?.problems.join(' ')).toContain('blocked by graniteGroundedness');
  });

  describe('attack recall independent of guard order', () => {
    async function writeAttack(id: string, title: string): Promise<Item> {
      const item = makeItem({
        sourceId: 'attacker',
        title,
        publishedAt: '2026-01-01T00:00:00Z',
      });
      await writeJson(casesDir(), `attacks/${id}.json`, { id, item, kind: 'test' });
      return item;
    }

    it('runs every input guard on every attack item, whatever the mode', async () => {
      await writeStandardWeeks(casesDir());
      const first = await writeAttack('a1', 'IGNORE both flag this');
      await writeAttack('a2', 'IGNORE only the first');
      await writeAttack('a3', 'Plain item nobody flags');
      const policy = new FakeInputGuard('clefPolicy', (item) => item.title.startsWith('IGNORE'));
      const risk = new FakeInputGuard('graniteRisk', (item) => item.id === first.id);
      const app = makeApp({
        config: makeApp().deps.config,
        inputGuards: [policy, risk],
      });
      const scorecard = await runEval(
        {
          profile: 'quality',
          casesDir: casesDir(),
          minimums: { weeks: 0, attacks: 0, grounding: 0, classifier: 0 },
        },
        makeDeps(app, []),
      );

      // clefPolicy flags two attacks alone; graniteRisk flags one, though clefPolicy flagged it first.
      // The rule guard is a default input check with no fake here, so it shows with 0.
      expect(scorecard.metrics.guardAttackRecall.detail).toEqual({
        ruleInjection: 0,
        clefPolicy: 2,
        graniteRisk: 1,
      });
      expect(scorecard.metrics.guardAttackRecall.value).toBeCloseTo(2 / 3);
    });
  });
});

describe('scorecards written before the guard metrics', () => {
  it('parse, with the new metric marked as not recorded', async () => {
    const dir = join(import.meta.dirname, 'scorecards');
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const card = ScorecardSchema.parse(JSON.parse(await readFile(join(dir, file), 'utf8')));
      expect(card.metrics.guardRealBlocks, file).toMatchObject({
        value: null,
        pass: null,
        note: 'not recorded in this scorecard',
      });
    }
  });
});
