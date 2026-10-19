import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../../src/shared/clock';
import { attempt, inTurn, timed } from './runner';

describe('attempt', () => {
  it('returns the answer of a call that worked', async () => {
    const lines: string[] = [];
    expect(
      await attempt(
        (l) => lines.push(l),
        'item a',
        () => Promise.resolve(7),
      ),
    ).toBe(7);
    expect(lines).toEqual([]);
  });

  it('keeps the message of a call that threw and reports it', async () => {
    const lines: string[] = [];
    const result = await attempt(
      (l) => lines.push(l),
      'item a',
      () => Promise.reject(new Error('model timed out')),
    );
    expect(result).toEqual({ error: 'model timed out' });
    expect(lines).toEqual(['item a failed: model timed out']);
  });

  it('calls a throw without a message an unknown error', async () => {
    const result = await attempt(
      () => undefined,
      'item a',
      () => Promise.reject(new Error('')),
    );
    expect(result).toEqual({ error: 'unknown error' });
  });
});

describe('inTurn', () => {
  it('runs the calls one after the other and keeps the results in order', async () => {
    const running: number[] = [];
    let active = 0;
    const results = await inTurn(
      () => undefined,
      'numbers',
      [1, 2, 3],
      async (n) => {
        active += 1;
        running.push(active);
        await Promise.resolve();
        active -= 1;
        return n * 2;
      },
    );
    expect(results).toEqual([2, 4, 6]);
    expect(running).toEqual([1, 1, 1]);
  });

  it('reports every tenth subject and the last one', async () => {
    const lines: string[] = [];
    const values = Array.from({ length: 23 }, (_, i) => i);
    await inTurn(
      (l) => lines.push(l),
      'items',
      values,
      (n) => Promise.resolve(n),
    );
    expect(lines).toEqual(['items: 10/23', 'items: 20/23', 'items: 23/23']);
  });

  it('reports nothing for no subjects', async () => {
    const lines: string[] = [];
    expect(
      await inTurn(
        (l) => lines.push(l),
        'items',
        [],
        () => Promise.resolve(1),
      ),
    ).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe('timed', () => {
  it('returns the value and the milliseconds the call took', async () => {
    let now = Date.parse('2026-10-17T10:00:00Z');
    const clock = { now: () => new Date((now += 250)) };
    expect(await timed(clock, () => Promise.resolve('done'))).toEqual({ value: 'done', ms: 250 });
  });

  it('gives zero, never a negative duration, when the clock steps back', async () => {
    let now = Date.parse('2026-10-17T10:00:00Z');
    const clock = { now: () => new Date((now -= 1000)) };
    expect((await timed(clock, () => Promise.resolve(1))).ms).toBe(0);
  });

  it('measures nothing on a frozen clock', async () => {
    const clock = fixedClock('2026-10-17T10:00:00Z');
    expect((await timed(clock, () => Promise.resolve(1))).ms).toBe(0);
  });
});
