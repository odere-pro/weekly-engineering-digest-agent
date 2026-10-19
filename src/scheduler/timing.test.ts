import { describe, expect, it } from 'vitest';
import { HOUR_MS, isTimerDelay, MAX_TIMER_MS, MINUTE_MS } from './timing';

describe('timing constants', () => {
  it('counts a minute as 60 seconds and an hour as 60 minutes', () => {
    expect(MINUTE_MS).toBe(60_000);
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
  });

  it('keeps the longest timer delay at 2^31 - 1 ms', () => {
    expect(MAX_TIMER_MS).toBe(2_147_483_647);
  });
});

describe('isTimerDelay', () => {
  it.each<{ name: string; ms: number; expected: boolean }>([
    { name: 'one millisecond', ms: 1, expected: true },
    { name: 'an hour', ms: HOUR_MS, expected: true },
    { name: 'the longest delay a timer holds', ms: MAX_TIMER_MS, expected: true },
    { name: 'zero', ms: 0, expected: false },
    { name: 'a negative number', ms: -1, expected: false },
    { name: 'not a number', ms: Number.NaN, expected: false },
    { name: 'infinity', ms: Number.POSITIVE_INFINITY, expected: false },
    { name: 'one millisecond past what a timer holds', ms: MAX_TIMER_MS + 1, expected: false },
  ])('$name: a timer delay is $expected', ({ ms, expected }) => {
    expect(isTimerDelay(ms)).toBe(expected);
  });
});
