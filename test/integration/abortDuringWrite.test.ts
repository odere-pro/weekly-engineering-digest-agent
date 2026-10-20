// An aborted run stops inside the write step, not after it: the run's signal reaches the writer
// call. The writer here answers nothing until its signal fires; without the wiring the run would
// wait out the 600 s writer timeout. Like the collect case (abortDuringCollect.test.ts).
import { describe, expect, it } from 'vitest';
import { runDigest } from '../../src/digest/runDigest';
import { isUnretriable } from '../../src/digest/ending/notes/unretriable';
import { ExitCode } from '../../src/domain/schemas';
import type { GenerateRequest, ModelProvider } from '../../src/models/ModelProvider';
import type { FakeModelProvider } from '../fakes';
import { FIRST_WRITER, FRIDAY, TEST_TIMEOUT_MS, WEEK } from './harness/constants';
import { createWorld } from './harness/world';
import { useDataDir } from './harness/dataDir';
import { readTextIfExists } from '../../src/shared/atomicFile';
import { readRunJson, runFile } from './harness/runFiles';
import { lockExists } from './harness/lock';

const dataDir = useDataDir();

/** How long after the first writer call started the run is told to stop. */
const ABORT_AFTER_MS = 50;
/** Far under the 600 s writer timeout the run would otherwise wait out. */
const PROMPT_MS = 1_000;

/** The fake model, except that a writer call ends only when its signal fires, like Ollama's. */
function hangingWriter(fake: FakeModelProvider, onWrite: (request: GenerateRequest) => void) {
  const model: ModelProvider = {
    generate: async (request) => {
      if (request.role !== 'write') return fake.generate(request);
      onWrite(request);
      await new Promise<void>((resolve) => {
        request.signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      request.signal?.throwIfAborted();
      return fake.generate(request);
    },
    decide: (request) => fake.decide(request),
    health: () => fake.health(),
  };
  return model;
}

describe('integration: a run aborted while the first writer is drafting', () => {
  it(
    'ends failed within a second of the abort, names the write step, and records no failed writer',
    async () => {
      const controller = new AbortController();
      const writers: (string | undefined)[] = [];
      let abortedAt = 0;
      // The clock starts with the first writer call, so the abort always lands inside the step.
      const onWrite = (request: GenerateRequest): void => {
        if (writers.push(request.model) > 1) return;
        setTimeout(() => {
          abortedAt = Date.now();
          controller.abort(new Error(`run time limit of ${ABORT_AFTER_MS} ms reached`));
        }, ABORT_AFTER_MS);
      };
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        model: ({ fake }) => hangingWriter(fake, onWrite),
      });

      // notifyFailure false is the scheduler's way of holding the note for a retry.
      const result = await runDigest(world.deps, {
        signal: controller.signal,
        notifyFailure: false,
      });

      expect(Date.now() - abortedAt).toBeLessThan(PROMPT_MS);
      expect(result.exitCode).toBe(ExitCode.Failed);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('failed');
      expect(record.error?.step).toBe('write');
      expect(record.error?.message).toBe(
        `Run aborted during the write step: run time limit of ${ABORT_AFTER_MS} ms reached`,
      );
      expect(isUnretriable(record.error?.message)).toBe(true);
      // The steps before the write step are kept; the aborted writer is nobody's failure.
      expect(record.timings.map((timing) => timing.step)).toEqual([
        'collect',
        'guardInput',
        'classify',
        'process',
        'write',
      ]);
      expect(record.drafts).toEqual([]);
      expect(await readTextIfExists(runFile(dataDir(), WEEK, 'drafts.json'))).toBeUndefined();
      // Writers run in turn: the second never started, and no judge ran.
      expect(writers).toEqual([FIRST_WRITER]);
      expect(world.fake.decideCalls.some((call) => call.role === 'judge')).toBe(false);
      expect(await lockExists(dataDir())).toBe(false);
      for (const delivery of world.deliveries) {
        expect(delivery.digests).toEqual([]);
        expect(delivery.failures).toHaveLength(1);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
