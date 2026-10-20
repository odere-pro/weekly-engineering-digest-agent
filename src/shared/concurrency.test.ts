import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('keeps the input order even when a later input finishes first', async () => {
    const delays = [30, 1, 15];

    const results = await mapWithConcurrency(delays, 3, async (ms) => {
      await sleep(ms);
      return `done after ${ms}`;
    });

    expect(results).toEqual(['done after 30', 'done after 1', 'done after 15']);
  });

  it('never runs more than `limit` at a time, and uses all of them', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 9 }, (_, i) => i),
      4,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight -= 1;
      },
    );

    expect(peak).toBe(4);
  });

  it('starts inputs in order as workers free up', async () => {
    const started: number[] = [];

    await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (input) => {
      started.push(input);
      await sleep(2);
    });

    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it('runs one at a time when the limit is 1', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3], 1, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(2);
      inFlight -= 1;
    });

    expect(peak).toBe(1);
  });

  it('runs every input at once when the limit is larger than the list', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2], 10, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(2);
      inFlight -= 1;
    });

    expect(peak).toBe(2);
  });

  it('returns an empty list for no inputs, without calling the function', async () => {
    let calls = 0;

    const results = await mapWithConcurrency([], 4, () => {
      calls += 1;
      return Promise.resolve(calls);
    });

    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it('does not change the list it is given', async () => {
    const inputs = Object.freeze([3, 2, 1]);

    const results = await mapWithConcurrency(inputs, 2, (input) => Promise.resolve(input * 2));

    expect(results).toEqual([6, 4, 2]);
    expect(inputs).toEqual([3, 2, 1]);
  });

  it('rejects with the error of a failing input', async () => {
    const run = mapWithConcurrency([1, 2, 3], 2, (input) =>
      input === 2 ? Promise.reject(new Error('input 2 failed')) : Promise.resolve(input),
    );

    await expect(run).rejects.toThrow('input 2 failed');
  });
});
