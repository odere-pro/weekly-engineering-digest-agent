import { describe, expect, it } from 'vitest';
import { createClefPolicyGuard } from '../../../src/guards/adapters/clefPolicy';
import { makeItem } from '../../../test/builders';
import { FakeModelProvider, yesNoAnswers } from '../../../test/fakes';
import { ATTACKS, CLEAN, CLEAN_DRAFTS, policy, repeat, rubric } from '../__fixtures__/records';
import type { InputGuardRecord, OutputGuardRecord } from '../capture/schemas';
import {
  graniteResult,
  guardFlagPoint,
  guardSamples,
  sweepGuardFlag,
  type GuardFlagPoint,
  type GuardSweep,
} from './guardFlag';

function pointAt(sweep: GuardSweep, value: number): GuardFlagPoint {
  const point = sweep.curve.find((p) => p.value === value);
  if (!point) throw new Error(`no curve point at ${value}`);
  return point;
}

describe('sweepGuardFlag', () => {
  it('catches the most attacks within the false-block budget, with a margin', () => {
    // 0.45-0.85 catch 3 attacks with no clean item over the flag; 0.55 is the closest to the
    // default with two steps of margin.
    const sweep = sweepGuardFlag([...CLEAN, ...ATTACKS], CLEAN_DRAFTS, 0.5);
    expect(sweep.chosen).toBe(0.55);
    expect(pointAt(sweep, 0.55)).toMatchObject({ policyFalseBlockRate: 0, attacksCaught: 3 });
  });

  it('never proposes a flag whose false blocks are over 5%, even when it catches more', () => {
    const sweep = sweepGuardFlag([...CLEAN, ...ATTACKS], CLEAN_DRAFTS, 0.25);
    expect(pointAt(sweep, 0.25)).toMatchObject({ policyFalseBlockRate: 0.1, attacksCaught: 4 });
    expect(sweep.chosen).toBe(0.55);
  });

  it('keeps clefRubric within the budget on the clean drafts too, because it shares guardFlag', () => {
    const drafts = [rubric('control', 0.62), rubric('control', 0.1)];
    const sweep = sweepGuardFlag([...CLEAN, ...ATTACKS], drafts, 0.5);
    expect(sweep.chosen).toBe(0.75);
    expect(pointAt(sweep, 0.6).rubricFalseBlockRate).toBe(0.5);
  });

  it('reports granite verdicts, which no threshold changes', () => {
    const clean = [...CLEAN.slice(1), policy('clean', 0.01, true)];
    const sweep = sweepGuardFlag([...clean, ...ATTACKS], CLEAN_DRAFTS, 0.5);
    expect(sweep.granite).toMatchObject({ clean: 20, attacks: 5, falseBlockRate: 0.05 });
    expect(sweep.granite.attacksCaught).toBe(3);
  });

  it('counts an item as blocked in "any" mode when either guard flags it', () => {
    const clean = [...CLEAN.slice(1), policy('clean', 0.01, true)];
    const sweep = sweepGuardFlag([...clean, ...ATTACKS], CLEAN_DRAFTS, 0.5);
    expect(pointAt(sweep, 0.25)).toMatchObject({ anyFalseBlockRate: 0.15, anyAttacksCaught: 4 });
  });

  it('leaves out failed guard calls and counts them', () => {
    const failed: InputGuardRecord = { ...policy('clean', 0), clefPolicy: { error: 'timeout' } };
    const sweep = sweepGuardFlag([...CLEAN, ...ATTACKS, failed], CLEAN_DRAFTS, 0.5);
    expect(sweep.failed).toEqual({ clefPolicy: 1, graniteRisk: 0, clefRubric: 0 });
    expect(sweep.clean).toBe(20);
  });

  it('counts the answered clean and attack records, control and planted drafts', () => {
    const sweep = sweepGuardFlag([...CLEAN, ...ATTACKS], CLEAN_DRAFTS, 0.5);
    expect(sweep).toMatchObject({ clean: 20, attacks: 5, controls: 2, planted: 1 });
    expect(sweep.curve).toHaveLength(21);
  });
});

describe('sweepGuardFlag edge cases', () => {
  it('does not flag a probability equal to guardFlag, like the clefPolicy guard', async () => {
    const model = new FakeModelProvider({ decide: (request) => yesNoAnswers(request, 0.5) });
    const guard = createClefPolicyGuard({ model, flagThreshold: 0.5 });
    expect((await guard.checkItem(makeItem())).flagged).toBe(false);
    const sweep = sweepGuardFlag([policy('clean', 0.5), ...ATTACKS], CLEAN_DRAFTS, 0.5);
    expect(pointAt(sweep, 0.5).policyFalseBlockRate).toBe(0);
    expect(pointAt(sweep, 0.45).policyFalseBlockRate).toBe(1);
  });

  it('lists the clean items clefPolicy still flags at the chosen value', () => {
    const outlier = { ...policy('clean', 0.99), itemId: 'outlier', title: 'Outlier' };
    const clean = [...repeat(19, () => policy('clean', 0.01)), outlier];
    const sweep = sweepGuardFlag([...clean, ...ATTACKS], CLEAN_DRAFTS, 0.5);
    expect(sweep.proposed.policyFalseBlockRate).toBe(0.05);
    expect(sweep.falseBlocks).toEqual([{ itemId: 'outlier', title: 'Outlier', from: '2026-W40' }]);
  });

  it('leaves failed granite and clefRubric calls out of their numbers', () => {
    const graniteFailed = { ...policy('clean', 0.01), graniteRisk: { error: 'timeout' } };
    const rubricFailed: OutputGuardRecord = { ...rubric('control', 0), clefRubric: { error: 'x' } };
    const sweep = sweepGuardFlag(
      [...CLEAN, ...ATTACKS, graniteFailed],
      [...CLEAN_DRAFTS, rubricFailed],
      0.5,
    );
    expect(sweep.failed).toEqual({ clefPolicy: 0, graniteRisk: 1, clefRubric: 1 });
    expect(sweep.granite.clean).toBe(20);
    expect(sweep.controls).toBe(2);
  });

  it('proposes the top of the grid when every lower value over-blocks', () => {
    const noisy = repeat(10, () => policy('clean', 1));
    const sweep = sweepGuardFlag([...noisy, ...ATTACKS], CLEAN_DRAFTS, 0.35);
    // A probability of 1 is flagged at every grid value below 1, so only 1.0 is feasible.
    expect(sweep.chosen).toBe(1);
    expect(sweep.proposed.attacksCaught).toBe(0);
  });
});

describe('guardSamples', () => {
  it('keeps the answered calls and pairs both input guards for mode "any"', () => {
    const answered = policy('clean', 0.2, true);
    const policyFailed: InputGuardRecord = { ...policy('clean', 0), clefPolicy: { error: 'x' } };
    const graniteFailed: InputGuardRecord = {
      ...policy('attack', 0.9),
      graniteRisk: { error: 'x' },
    };
    const rubricFailed: OutputGuardRecord = { ...rubric('control', 0), clefRubric: { error: 'x' } };
    const samples = guardSamples(
      [answered, policyFailed, graniteFailed],
      [rubric('planted', 0.3), rubricFailed],
    );
    expect(samples.policy.map((s) => s.policy)).toEqual([0.2, 0.9]);
    expect(samples.rubric).toEqual([{ draft: 'planted', probability: 0.3 }]);
    expect(samples.both).toEqual([{ kind: 'clean', policy: 0.2, granite: true }]);
  });
});

describe('guardFlagPoint', () => {
  const samples = guardSamples(
    [policy('clean', 0.3), policy('clean', 0.6), policy('attack', 0.6), policy('attack', 0.2)],
    [rubric('control', 0.4), rubric('planted', 0.4)],
  );

  it('flags only a probability above the value', () => {
    expect(guardFlagPoint(samples, 0.6)).toMatchObject({
      policyFalseBlockRate: 0,
      attacksCaught: 0,
      rubricFalseBlockRate: 0,
      plantedFlagged: 0,
    });
    expect(guardFlagPoint(samples, 0.55)).toMatchObject({
      policyFalseBlockRate: 0.5,
      attacksCaught: 1,
    });
  });

  it('reads the rubric on control drafts for false blocks and on planted ones as information', () => {
    expect(guardFlagPoint(samples, 0.35)).toMatchObject({
      rubricFalseBlockRate: 1,
      plantedFlagged: 1,
    });
  });

  it('has no rate without records of its kind', () => {
    expect(guardFlagPoint(guardSamples([], []), 0.5)).toEqual({
      value: 0.5,
      policyFalseBlockRate: null,
      attacksCaught: 0,
      rubricFalseBlockRate: null,
      plantedFlagged: 0,
      anyFalseBlockRate: null,
      anyAttacksCaught: 0,
    });
  });
});

describe('graniteResult', () => {
  it('names the clean items granite flagged and counts the attacks it caught', () => {
    const flagged = { ...policy('clean', 0.1, true), itemId: 'c1', title: 'Flagged' };
    const result = graniteResult([
      flagged,
      policy('clean', 0.1),
      policy('attack', 0.1, true),
      policy('attack', 0.1),
    ]);
    expect(result).toEqual({
      clean: 2,
      attacks: 2,
      falseBlockRate: 0.5,
      attacksCaught: 1,
      falseBlocks: [{ itemId: 'c1', title: 'Flagged', from: '2026-W40' }],
    });
  });

  it('leaves out failed calls and has no rate without clean answers', () => {
    const failed: InputGuardRecord = { ...policy('clean', 0), graniteRisk: { error: 'x' } };
    expect(graniteResult([failed])).toMatchObject({ clean: 0, falseBlockRate: null });
  });
});
