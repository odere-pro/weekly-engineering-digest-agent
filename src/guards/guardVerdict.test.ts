import { describe, expect, it } from 'vitest';
import { GuardCheckIdSchema, GuardVerdictSchema } from './guardVerdict';

describe('guard check ids', () => {
  it('includes the rule-based injection check (W11-04), first', () => {
    expect(GuardCheckIdSchema.options).toContain('ruleInjection');
    expect(GuardCheckIdSchema.options[0]).toBe('ruleInjection');
  });
});

describe('GuardVerdictSchema', () => {
  it('accepts a verdict with and without a probability or reason', () => {
    expect(GuardVerdictSchema.parse({ check: 'clefPolicy', flagged: false })).toEqual({
      check: 'clefPolicy',
      flagged: false,
    });
    expect(
      GuardVerdictSchema.parse({
        check: 'graniteRisk',
        flagged: true,
        probability: 0.9,
        reason: 'jailbreak',
      }).probability,
    ).toBe(0.9);
  });

  it('rejects an unknown check or a probability outside 0..1', () => {
    expect(GuardVerdictSchema.safeParse({ check: 'other', flagged: true }).success).toBe(false);
    expect(
      GuardVerdictSchema.safeParse({ check: 'clefPolicy', flagged: true, probability: 1.5 })
        .success,
    ).toBe(false);
  });
});
