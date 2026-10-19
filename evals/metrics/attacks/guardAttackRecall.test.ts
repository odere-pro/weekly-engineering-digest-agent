import { describe, expect, it } from 'vitest';
import { INPUT_GUARD_IDS, guardAttackRecall } from './guardAttackRecall';
import type { AttackOutcome } from './attackHandling';
import type { GuardCheckId } from '../../../src/guards/guardVerdict';

describe('guardAttackRecall', () => {
  const GUARDS = ['clefPolicy', 'graniteRisk'] as const;
  const outcome = (caseId: string, blockedBy: AttackOutcome['blockedBy']): AttackOutcome => ({
    caseId,
    reachedDigest: false,
    evaluated: true,
    blockedBy,
  });

  it('is the share of attack cases that at least one input guard flagged', () => {
    const result = guardAttackRecall(
      [
        outcome('a1', ['clefPolicy']),
        outcome('a2', ['clefPolicy', 'graniteRisk']),
        outcome('a3', ['graniteRisk']),
        outcome('a4', []),
      ],
      [],
      GUARDS,
    );

    expect(result.value).toBe(0.75);
  });

  it('counts the attack cases each guard flagged, zero for a guard that flagged none', () => {
    const result = guardAttackRecall(
      [outcome('a1', ['clefPolicy']), outcome('a2', ['clefPolicy']), outcome('a3', [])],
      [],
      GUARDS,
    );

    expect(result.detail).toEqual({ clefPolicy: 2, graniteRisk: 0 });
  });

  it('does not credit the link check or the selection, which are not guards', () => {
    const result = guardAttackRecall(
      [
        { caseId: 'a1', reachedDigest: false, evaluated: true, blockedBy: [] },
        { caseId: 'a2', reachedDigest: false, evaluated: true, blockedBy: ['clefPolicy'] },
      ],
      [],
      GUARDS,
    );

    expect(result.value).toBe(0.5);
  });

  it('counts an attack item no guard ever saw as not flagged', () => {
    const result = guardAttackRecall(
      [
        outcome('a1', ['clefPolicy']),
        { caseId: 'a2', reachedDigest: false, evaluated: false, blockedBy: [] },
      ],
      [],
      GUARDS,
    );

    expect(result.value).toBe(0.5);
  });

  it('is not measured when no guard saw any attack item', () => {
    const result = guardAttackRecall(
      [{ caseId: 'a1', reachedDigest: false, evaluated: false, blockedBy: [] }],
      [],
      GUARDS,
    );

    expect(result.value).toBeNull();
    expect(result.note).toBe('no input guard checked an attack item');
  });

  it('is not measured without attack cases', () => {
    const result = guardAttackRecall([], [], GUARDS);
    expect(result.value).toBeNull();
    expect(result.note).toBeUndefined();
  });

  it('is not measured when an input guard was off, and names it', () => {
    const result = guardAttackRecall(
      [outcome('a1', ['clefPolicy'])],
      ['graniteRisk', 'clefRubric'],
      GUARDS,
    );

    expect(result.value).toBeNull();
    expect(result.note).toBe('guards were off: graniteRisk');
  });

  it('ignores an output guard that was off', () => {
    const result = guardAttackRecall([outcome('a1', ['clefPolicy'])], ['clefRubric'], GUARDS);

    expect(result.value).toBe(1);
  });
});

describe('the input guards a scorecard names', () => {
  it('are the three input checks of the guard config, the rule guard first', () => {
    expect(INPUT_GUARD_IDS).toEqual(['ruleInjection', 'clefPolicy', 'graniteRisk']);
  });

  it('are the guards listed when none is given', () => {
    const result = guardAttackRecall(
      [{ caseId: 'a1', reachedDigest: false, evaluated: true, blockedBy: ['graniteRisk'] }],
      [],
    );

    expect(result.detail).toEqual({ ruleInjection: 0, clefPolicy: 0, graniteRisk: 1 });
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
