// The guards measured on the real recorded weeks through runEval, per-guard attack recall that
// does not depend on guard order, and the cause of a week without a digest. The measurement
// functions themselves are tested in metrics/guards/ and metrics/attacks/.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScorecardSchema } from './schema';
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
