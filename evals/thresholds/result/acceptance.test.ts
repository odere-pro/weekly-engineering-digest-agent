import { describe, expect, it } from 'vitest';
import { DEFAULTS, rawCapture } from '../__fixtures__/records';
import { sweepFilter } from '../sweep/filter';
import { sweepGuardFlag } from '../sweep/guardFlag';
import { acceptanceOf, atLeast, atMost } from './acceptance';

describe('atLeast', () => {
  it('passes at the minimum and above, and fails below', () => {
    expect(atLeast(0.8, 0.8)).toEqual({ value: 0.8, min: 0.8, pass: true });
    expect(atLeast(0.9, 0.8).pass).toBe(true);
    expect(atLeast(0.79, 0.8).pass).toBe(false);
  });

  it('absorbs floating-point noise at the boundary', () => {
    expect(atLeast(0.7999999999999999, 0.8).pass).toBe(true);
  });

  it('fails a value that could not be measured', () => {
    expect(atLeast(null, 0.8)).toEqual({ value: null, min: 0.8, pass: false });
  });
});

describe('atMost', () => {
  it('passes at the maximum and below, and fails above', () => {
    expect(atMost(0.05, 0.05)).toEqual({ value: 0.05, max: 0.05, pass: true });
    expect(atMost(0, 0.05).pass).toBe(true);
    expect(atMost(0.06, 0.05).pass).toBe(false);
  });

  it('absorbs floating-point noise at the boundary', () => {
    expect(atMost(0.05000000000000001, 0.05).pass).toBe(true);
  });

  it('fails a value that could not be measured', () => {
    expect(atMost(null, 0.05)).toEqual({ value: null, max: 0.05, pass: false });
  });
});

describe('acceptanceOf', () => {
  const raw = rawCapture();
  const filter = sweepFilter(raw.classifier, DEFAULTS);
  const guard = sweepGuardFlag(raw.inputGuards, raw.outputGuards, 0.5);

  it('judges the proposed thresholds against the spec gates', () => {
    expect(acceptanceOf({ scorecardAccuracy: 0.9, filter, guard, failedCalls: 0 })).toEqual({
      classifierAccuracy: { value: 0.9, min: 0.8, pass: true },
      filterAccuracy: { value: 1, min: 0.8, pass: true },
      guardFalseBlocks: { value: 0, max: 0.05, pass: true },
      inputFalseBlocksAnyMode: { value: 0, max: 0.05, pass: true },
      failedCalls: { count: 0, pass: true },
    });
  });

  it('fails the classifier gate on a low scorecard accuracy and the calls gate on any failure', () => {
    const result = acceptanceOf({ scorecardAccuracy: 0.5, filter, guard, failedCalls: 2 });
    expect(result.classifierAccuracy.pass).toBe(false);
    expect(result.failedCalls).toEqual({ count: 2, pass: false });
  });

  it('takes the worst of clefPolicy, clefRubric and granite for the guard gate', () => {
    const flagged = { ...guard.granite, falseBlockRate: 0.5 };
    const result = acceptanceOf({
      scorecardAccuracy: 1,
      filter,
      guard: { ...guard, granite: flagged },
      failedCalls: 0,
    });
    expect(result.guardFalseBlocks).toEqual({ value: 0.5, max: 0.05, pass: false });
  });
});
