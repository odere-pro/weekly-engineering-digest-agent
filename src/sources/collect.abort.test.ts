import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectStep, type CollectDeps, type CollectInput } from './collect';
import type { Item, Source } from '../domain/schemas';
import type { SourceFetcher } from './SourceFetcher';
import { FetchError } from '../shared/errors';
import { makeItem } from '../../test/builders';
import { fixedClock, noopLogger } from '../../test/fakes';

const SINCE = new Date('2026-10-05T00:00:00Z');
const UNTIL = new Date('2026-10-12T12:00:00Z');
const MAX_CONCURRENT_SOURCES = 4;

const makeSources = (count: number): Source[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `s${index + 1}`,
    kind: 'rss' as const,
    url: `https://example.com/s${index + 1}.xml`,
  }));

const makeInput = (sources: readonly Source[]): CollectInput => ({
  sources,
  since: SINCE,
  until: UNTIL,
  maxItemsPerSource: 10,
});

function makeDeps(fetcher: SourceFetcher, overrides: Partial<CollectDeps> = {}): CollectDeps {
  return { fetchers: { rss: fetcher }, logger: noopLogger, clock: fixedClock(UNTIL), ...overrides };
}

/** A fetch that waits for its signal and then fails with the signal's reason, as a real one does. */
async function hangUntilAborted(signal: AbortSignal | undefined): Promise<Item[]> {
  await new Promise<void>((resolve) => {
    signal?.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
  signal?.throwIfAborted();
  return [];
}

/** Records the ids it was asked for, then hangs until its signal fires. */
class HangingFetcher implements SourceFetcher {
  readonly kind = 'rss' as const;
  readonly started: string[] = [];

  fetch(source: Source, _window: unknown, signal?: AbortSignal): Promise<Item[]> {
    this.started.push(source.id);
    return hangUntilAborted(signal);
  }
}

const abortedWith = (reason: unknown): AbortController => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('collectStep when the run is told to stop', () => {
  it('starts no fetch and throws the reason when the signal fired before the start', async () => {
    const reason = new Error('run timed out after 2 h');
    const fetcher = new HangingFetcher();

    const result = collectStep(
      makeInput(makeSources(6)),
      makeDeps(fetcher, { signal: abortedWith(reason).signal }),
    );

    await expect(result).rejects.toBe(reason);
    expect(fetcher.started).toEqual([]);
  });

  it('stops a fetch that hangs until its signal fires', async () => {
    const reason = new Error('run timed out after 2 h');
    const controller = new AbortController();
    const fetcher = new HangingFetcher();
    // A long timeout: only the abort can end the wait before the test's own limit.
    const result = collectStep(
      makeInput(makeSources(2)),
      makeDeps(fetcher, { signal: controller.signal, timeoutMs: 60_000 }),
    );
    await vi.waitFor(() => {
      expect(fetcher.started).toHaveLength(2);
    });

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
  });

  it('does not list the source that was aborted as a failed source or log it as broken', async () => {
    const warn = vi.fn();
    const controller = new AbortController();
    const fetcher = new HangingFetcher();
    const result = collectStep(
      makeInput(makeSources(1)),
      makeDeps(fetcher, { signal: controller.signal, logger: { ...noopLogger, warn } }),
    );
    await vi.waitFor(() => {
      expect(fetcher.started).toHaveLength(1);
    });

    controller.abort(new Error('run timed out'));

    await expect(result).rejects.toThrow('run timed out');
    expect(warn).not.toHaveBeenCalledWith('Source failed', expect.anything());
  });

  it('starts no further source after the abort, even when a running fetch ignores the signal', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const finishAll: (() => void)[] = [];
    const ignoringSignal: SourceFetcher = {
      kind: 'rss',
      fetch: (source) => {
        started.push(source.id);
        return new Promise<Item[]>((resolve) => {
          finishAll.push(() => {
            resolve([makeItem({ sourceId: source.id, publishedAt: '2026-10-10T00:00:00Z' })]);
          });
        });
      },
    };
    const result = collectStep(
      makeInput(makeSources(8)),
      makeDeps(ignoringSignal, { signal: controller.signal }),
    );
    await vi.waitFor(() => {
      expect(started).toHaveLength(MAX_CONCURRENT_SOURCES);
    });

    controller.abort(new Error('run timed out'));
    finishAll.forEach((finish) => {
      finish();
    });

    await expect(result).rejects.toThrow('run timed out');
    expect(started).toHaveLength(MAX_CONCURRENT_SOURCES);
  });

  it('ends a retry back-off at once and makes no further attempt', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error('run timed out');
    let attempts = 0;
    const flaky: SourceFetcher = {
      kind: 'rss',
      fetch: () => {
        attempts += 1;
        return Promise.reject(new FetchError('HTTP 503', { status: 503, retryable: true }));
      },
    };
    const result = collectStep(
      makeInput(makeSources(1)),
      makeDeps(flaky, { signal: controller.signal }),
    );
    const settled = result.catch((error: unknown) => error);
    // The first attempt has failed and the 500 ms back-off is running; no timer is advanced.
    await vi.advanceTimersByTimeAsync(10);
    expect(attempts).toBe(1);

    controller.abort(reason);

    await expect(settled).resolves.toBe(reason);
    expect(attempts).toBe(1);
  });

  it('aborts the signal a fetcher got, with the run reason, when the run is told to stop', async () => {
    const controller = new AbortController();
    const reason = new Error('run timed out');
    const seen: AbortSignal[] = [];
    const fetcher: SourceFetcher = {
      kind: 'rss',
      fetch: (_source, _window, signal) => {
        if (signal) seen.push(signal);
        return hangUntilAborted(signal);
      },
    };
    const result = collectStep(
      makeInput(makeSources(1)),
      makeDeps(fetcher, { signal: controller.signal }),
    );
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(seen[0]?.aborted).toBe(false);

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    expect(seen[0]?.aborted).toBe(true);
    expect(seen[0]?.reason).toBe(reason);
  });

  it('still lists a failing source and returns the others when the signal has not fired', async () => {
    const controller = new AbortController();
    const good = makeItem({ sourceId: 's2', publishedAt: '2026-10-10T00:00:00Z' });
    const fetcher: SourceFetcher = {
      kind: 'rss',
      fetch: (source) =>
        source.id === 's1'
          ? Promise.reject(new FetchError('HTTP 404', { status: 404, retryable: false }))
          : Promise.resolve([good]),
    };

    const out = await collectStep(
      makeInput(makeSources(2)),
      makeDeps(fetcher, { signal: controller.signal }),
    );

    expect(out.items).toEqual([good]);
    expect(out.failedSources).toEqual([{ sourceId: 's1', error: 'HTTP 404' }]);
  });
});
