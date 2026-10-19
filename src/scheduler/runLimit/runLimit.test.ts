import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUR_MS, MAX_TIMER_MS, MINUTE_MS } from '../timing';
import { DEFAULT_RUN_TIMEOUT_MS, describeDuration, startRunLimit, type RunLimit } from './runLimit';

afterEach(() => {
  vi.useRealTimers();
});

describe('DEFAULT_RUN_TIMEOUT_MS', () => {
  it('is three hours', () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(3 * HOUR_MS);
  });
});

describe('describeDuration', () => {
  it.each<[number, string]>([
    [3 * HOUR_MS, '3 h'],
    [HOUR_MS, '1 h'],
    [90 * MINUTE_MS, '90 min'],
    [MINUTE_MS, '1 min'],
    [30_000, '30 s'],
    [1_000, '1 s'],
    [1_500, '1500 ms'],
    [1, '1 ms'],
  ])('names %d ms as %s', (ms, expected) => {
    expect(describeDuration(ms)).toBe(expected);
  });
});

describe('startRunLimit', () => {
  it('gives a signal that has not fired and a run that has not timed out', () => {
    vi.useFakeTimers();
    const limit = startRunLimit(1_000, vi.fn());

    expect(limit.signal.aborted).toBe(false);
    expect(limit.timedOut()).toBe(false);
    limit.clear();
  });

  it('fires the signal when the limit passes, not a millisecond before', async () => {
    vi.useFakeTimers();
    const limit = startRunLimit(1_000, vi.fn());

    await vi.advanceTimersByTimeAsync(999);
    expect(limit.timedOut()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(limit.signal.aborted).toBe(true);
    expect(limit.timedOut()).toBe(true);
  });

  it('writes the reason itself: the limit, in the unit that fits', async () => {
    vi.useFakeTimers();
    const limit = startRunLimit(90 * MINUTE_MS, vi.fn());

    await vi.advanceTimersByTimeAsync(90 * MINUTE_MS);

    const reason: unknown = limit.signal.reason;
    expect(reason).toBeInstanceOf(Error);
    expect((reason as Error).message).toBe('run timed out after 90 min');
  });

  it('calls onTimeout once, before the signal fires', async () => {
    vi.useFakeTimers();
    const abortedWhenCalled: boolean[] = [];
    const created: RunLimit[] = [];
    created.push(
      startRunLimit(1_000, () => {
        abortedWhenCalled.push(created[0]?.signal.aborted ?? true);
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(abortedWhenCalled).toEqual([false]);
    expect(created[0]?.signal.aborted).toBe(true);
  });

  it('stops the timer on clear(): the signal never fires', async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const limit = startRunLimit(1_000, onTimeout);

    limit.clear();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(vi.getTimerCount()).toBe(0);
    expect(limit.signal.aborted).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('keeps timedOut() true after clear() once the limit has fired', async () => {
    vi.useFakeTimers();
    const limit = startRunLimit(1_000, vi.fn());
    await vi.advanceTimersByTimeAsync(1_000);

    limit.clear();

    expect(limit.timedOut()).toBe(true);
  });

  it.each<[string, number]>([
    ['zero', 0],
    ['negative', -1],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['beyond what a timer can hold', MAX_TIMER_MS + 1],
  ])('sets no limit for a time that is %s', async (_name, ms) => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const limit = startRunLimit(ms, onTimeout);

    await vi.advanceTimersByTimeAsync(100 * HOUR_MS);

    expect(vi.getTimerCount()).toBe(0);
    expect(limit.timedOut()).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
    limit.clear();
  });
});
