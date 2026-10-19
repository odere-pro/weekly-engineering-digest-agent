import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUR_MS, MAX_TIMER_MS } from '../timing';
import { budgetOf, createWaiter } from './wait';

afterEach(() => {
  vi.useRealTimers();
});

describe('budgetOf', () => {
  it('keeps the wait and the whole number of tries', () => {
    expect(budgetOf(300_000, 24)).toEqual({ everyMs: 300_000, max: 24 });
  });

  it('rounds a fractional count down', () => {
    expect(budgetOf(1_000, 2.9)).toEqual({ everyMs: 1_000, max: 2 });
  });

  it('allows the longest wait a timer holds', () => {
    expect(budgetOf(MAX_TIMER_MS, 1)).toEqual({ everyMs: MAX_TIMER_MS, max: 1 });
  });

  it.each<[string, number, number]>([
    ['a zero wait', 0, 2],
    ['a negative wait', -1_000, 2],
    ['a wait that is not a number', Number.NaN, 2],
    ['a wait beyond what a timer holds (it would fire at once)', MAX_TIMER_MS + 1, 2],
    ['a count of zero', 1_000, 0],
    ['a negative count', 1_000, -1],
    ['a count that is not a number', 1_000, Number.NaN],
    ['less than one try', 1_000, 0.5],
  ])('turns retrying off for %s', (_name, everyMs, count) => {
    expect(budgetOf(everyMs, count).max).toBe(0);
  });

  it('keeps the asked wait even when retrying is off', () => {
    expect(budgetOf(0, 5)).toEqual({ everyMs: 0, max: 0 });
  });
});

describe('createWaiter', () => {
  it('resolves true once the time has passed, not a millisecond before', async () => {
    vi.useFakeTimers();
    const waiter = createWaiter();
    const settled = vi.fn();

    const waiting = waiter.wait(HOUR_MS).then(settled);
    await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;

    expect(settled).toHaveBeenCalledWith(true);
  });

  it('says it is waiting from the call until the time has passed', async () => {
    vi.useFakeTimers();
    const waiter = createWaiter();
    expect(waiter.isWaiting()).toBe(false);

    const waiting = waiter.wait(1_000);
    expect(waiter.isWaiting()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await waiting;

    expect(waiter.isWaiting()).toBe(false);
  });

  it('resolves false at once on cancel(), and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const waiter = createWaiter();
    const waiting = waiter.wait(HOUR_MS);

    waiter.cancel();

    await expect(waiting).resolves.toBe(false);
    expect(waiter.isWaiting()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does nothing on cancel() when nothing is waiting', () => {
    const waiter = createWaiter();

    expect(() => {
      waiter.cancel();
    }).not.toThrow();
    expect(waiter.isWaiting()).toBe(false);
  });

  it('waits again after a cancel', async () => {
    vi.useFakeTimers();
    const waiter = createWaiter();
    const first = waiter.wait(HOUR_MS);
    waiter.cancel();
    await first;

    const second = waiter.wait(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(second).resolves.toBe(true);
  });

  it('keeps separate waiters apart', async () => {
    vi.useFakeTimers();
    const one = createWaiter();
    const other = createWaiter();
    const waiting = one.wait(1_000);

    other.cancel();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waiting).resolves.toBe(true);
  });
});
