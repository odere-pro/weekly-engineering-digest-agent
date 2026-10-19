// An aborted run stops inside the collect step, not after it: the run's signal reaches the
// fetchers. The feeds here hang until their signal fires; without the wiring the run would wait
// out three 10 s attempts per source.
import { describe, expect, it } from 'vitest';
import { runDigest } from '../../src/digest/runDigest';
import { ExitCode, type Item, type Source } from '../../src/domain/schemas';
import type { FetchWindow, SourceFetcher } from '../../src/sources/SourceFetcher';
import { isUnretriable } from '../../src/digest/ending/notes/unretriable';
import { FRIDAY, TEST_TIMEOUT_MS, WEEK } from './harness/constants';
import { createWorld } from './harness/world';
import { useDataDir } from './harness/dataDir';
import { readRunJson } from './harness/runFiles';
import { lockExists } from './harness/lock';

const dataDir = useDataDir();

/** How long after the first fetch started the run is told to stop. */
const ABORT_AFTER_MS = 50;
/** Far under the 10 s attempt timeout the run would otherwise wait out. */
const PROMPT_MS = 1_000;

/** A feed that answers nothing until its signal fires, then fails with the signal's reason. */
function hangingFetcher(
  kind: SourceFetcher['kind'],
  onFetch: (source: Source) => void,
): SourceFetcher {
  return {
    kind,
    fetch: async (source: Source, _window: FetchWindow, signal?: AbortSignal) => {
      onFetch(source);
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
      return [] as Item[];
    },
  };
}

describe('integration: a run aborted while the feeds are loading', () => {
  it(
    'ends failed within a second of the abort, names the collect step, and sends its note',
    async () => {
      const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
      const controller = new AbortController();
      const started: string[] = [];
      let abortedAt = 0;
      // The clock starts with the first fetch, so the abort always lands inside the collect step.
      const onFetch = (source: Source): void => {
        if (started.push(source.id) > 1) return;
        setTimeout(() => {
          abortedAt = Date.now();
          controller.abort(new Error(`run time limit of ${ABORT_AFTER_MS} ms reached`));
        }, ABORT_AFTER_MS);
      };
      const deps = {
        ...world.deps,
        fetchers: {
          rss: hangingFetcher('rss', onFetch),
          github: hangingFetcher('github', onFetch),
        },
      };

      // notifyFailure false is the scheduler's way of holding the note for a retry.
      const result = await runDigest(deps, { signal: controller.signal, notifyFailure: false });

      expect(Date.now() - abortedAt).toBeLessThan(PROMPT_MS);
      expect(result.exitCode).toBe(ExitCode.Failed);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('failed');
      expect(record.error?.step).toBe('collect');
      expect(record.error?.message).toBe(
        `Run aborted during the collect step: run time limit of ${ABORT_AFTER_MS} ms reached`,
      );
      expect(isUnretriable(record.error?.message)).toBe(true);
      expect(record.failedSources).toEqual([]);
      expect(await lockExists(dataDir())).toBe(false);
      expect(world.fake.decideCalls).toEqual([]);
      for (const delivery of world.deliveries) {
        expect(delivery.digests).toEqual([]);
        expect(delivery.failures).toHaveLength(1);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
