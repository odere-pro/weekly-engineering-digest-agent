import { describe, expect, it, vi } from 'vitest';
import { TimeoutError, withRetry, withTimeout } from '../../src/shared/retry.js';

const noSleep = (): Promise<void> => Promise.resolve();

describe('withRetry', () => {
  it('returns the first successful result', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 10, sleep: noSleep })).resolves.toBe(
      'ok',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries with exponential backoff, then succeeds', async () => {
    const delays: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue('ok');
    const onRetry = vi.fn();
    const result = await withRetry(fn, {
      retries: 2,
      baseDelayMs: 100,
      onRetry,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    expect(result).toBe('ok');
    expect(delays).toEqual([100, 200]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('caps the delay at maxDelayMs', async () => {
    const delays: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue('ok');
    await withRetry(fn, {
      retries: 2,
      baseDelayMs: 100,
      maxDelayMs: 150,
      sleep: (ms) => (delays.push(ms), Promise.resolve()),
    });
    expect(delays).toEqual([100, 150]);
  });

  it('throws the last error after the retries run out', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1, sleep: noSleep })).rejects.toThrow(
      'down',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops early when shouldRetry says no', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fatal'));
    await expect(
      withRetry(fn, { retries: 5, baseDelayMs: 1, shouldRetry: () => false, sleep: noSleep }),
    ).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses a real timer when no sleep is injected', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('a')).mockResolvedValue('ok');
    await expect(withRetry(fn, { retries: 1, baseDelayMs: 1 })).resolves.toBe('ok');
  });
});

describe('withTimeout', () => {
  it('resolves when fn finishes in time', async () => {
    await expect(withTimeout(() => Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it('rejects with TimeoutError and aborts the signal', async () => {
    let seen: AbortSignal | undefined;
    const pending = withTimeout((signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    }, 5);
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it('aborts when the parent signal aborts', async () => {
    const parent = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = withTimeout(
      (signal) =>
        new Promise((_, reject) => {
          seen = signal;
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
      1000,
      parent.signal,
    );
    parent.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(seen?.aborted).toBe(true);
  });

  it('starts aborted when the parent is already aborted', async () => {
    const parent = new AbortController();
    parent.abort();
    await expect(
      withTimeout((signal) => Promise.resolve(signal.aborted), 1000, parent.signal),
    ).resolves.toBe(true);
  });
});
