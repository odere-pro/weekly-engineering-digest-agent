import { AsyncLocalStorage } from 'node:async_hooks';
import type { FetchWindow, SourceFetcher } from '../../SourceFetcher';
import type { Item, Source } from '../../../domain/schemas';
import { errorMessage } from '../../../shared/errors';
import type { Logger } from '../../../shared/telemetry';
import type { Answer } from '../http';
import type { SourceTap } from '../pipeline';
import type { SourceArchive, SourceRecording } from './sourceArchive';

export interface SourceArchivingOptions {
  archive: SourceArchive;
  /** The day folder of the run in flight; undefined outside a run, which archives nothing. */
  day: () => string | undefined;
  logger: Logger;
}

/** Saves what the fetches of a run answered and returned (`SourceArchive`). */
export interface SourceArchiving {
  /** Give it to every fetcher that `wrap` gets (`createRssFetcher({ tap })`). */
  tap: SourceTap;
  /** The fetcher, handing each outcome back unchanged and saving it in the background. */
  wrap(fetcher: SourceFetcher): SourceFetcher;
  /** Resolves once every save started so far is done; never rejects (a failed save is logged). */
  flush(): Promise<void>;
}

/**
 * Each fetch runs in its own async context, so the tap gives every fetch only its own source's
 * answers, even with sources fetched at once. The save starts after the fetch settled and is not
 * awaited by it: the collect step's timeout covers the network, never the disk. Saves of one day
 * and source run one after the other. When the collect step gave up on an attempt (timeout) and a
 * newer one started, the old attempt's save is skipped, so the folder keeps the newer attempt.
 */
export function createSourceArchiving(options: SourceArchivingOptions): SourceArchiving {
  const capture = new AsyncLocalStorage<Answer[]>();
  // Attempt numbers never repeat, so a very late attempt cannot pass for a newer one.
  let attempts = 0;
  const latestAttempt = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  let warnedNoDay = false;

  function dayOfRun(): string | undefined {
    try {
      return options.day();
    } catch (error) {
      if (!warnedNoDay) {
        warnedNoDay = true;
        options.logger.warn('Fetched data is not saved: the day folder of the run is unknown', {
          error: errorMessage(error),
        });
      }
      return undefined;
    }
  }

  function enqueue(key: string, attempt: number, run: () => Promise<void>): void {
    const next = (queues.get(key) ?? Promise.resolve())
      .then(async () => {
        if (latestAttempt.get(key) !== attempt) return;
        latestAttempt.delete(key);
        await run();
      })
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      });
    queues.set(key, next);
  }

  return {
    tap: {
      answer: ({ sourceId: _sourceId, ...answer }) => {
        capture.getStore()?.push(answer);
      },
    },
    wrap: (fetcher) => ({
      kind: fetcher.kind,
      async fetch(source: Source, window: FetchWindow, signal?: AbortSignal): Promise<Item[]> {
        const day = dayOfRun();
        if (day === undefined) return fetcher.fetch(source, window, signal);

        const key = `${day}/${source.id}`;
        const attempt = ++attempts;
        latestAttempt.set(key, attempt);
        const answers: Answer[] = [];
        const [outcome] = await capture.run(answers, () =>
          Promise.allSettled([fetcher.fetch(source, window, signal)]),
        );
        const items = outcome.status === 'fulfilled' ? outcome.value : undefined;
        enqueue(key, attempt, () =>
          save(options, day, source.id, { answers: [...answers], ...(items && { items }) }),
        );
        if (outcome.status === 'rejected') throw outcome.reason;
        return outcome.value;
      },
    }),
    async flush() {
      while (queues.size > 0) await Promise.all(queues.values());
    },
  };
}

async function save(
  options: SourceArchivingOptions,
  day: string,
  sourceId: string,
  recording: SourceRecording,
): Promise<void> {
  try {
    await options.archive.save(day, sourceId, recording);
  } catch (error) {
    options.logger.warn('Could not save the fetched data of a source', {
      sourceId,
      error: errorMessage(error),
    });
  }
}
