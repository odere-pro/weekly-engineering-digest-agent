// W5-09 (F13, F46): the scheduler's retry and run time limit through the real runDigest and the real run store,
// with the wiring `digest serve` uses. Only time is faked.
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDigest } from '../digest/runDigest';
import { sendHeldNote } from '../digest/ending/notes/failureNotes';
import type { ModelHealth } from '../models/ModelProvider';
import type { RunStore } from '../store/RunStore';
import {
  DEFAULT_FAILED_RETRY,
  startScheduler,
  type CronFactory,
  type SchedulerHandle,
  type SchedulerOptions,
} from './scheduler';
import { FRIDAY, TEST_TIMEOUT_MS, WEEK } from '../../test/integration/harness/constants';
import { createWorld, type World } from '../../test/integration/harness/world';
import { lockExists, writeLock } from '../../test/integration/harness/lock';
import { readRunJson, runFile } from '../../test/integration/harness/runFiles';
import { useDataDir } from '../../test/integration/harness/dataDir';

const HOUR_MS = 3_600_000;
const dataDir = useDataDir();
const handles: SchedulerHandle[] = [];

/** The service's wiring from `digest serve`, with a tick the test fires itself. */
async function serve(
  world: World,
  overrides: Partial<SchedulerOptions> = {},
): Promise<{ tick: () => Promise<void>; scheduler: SchedulerHandle }> {
  let tick: () => Promise<void> = () => Promise.resolve();
  const cronFactory: CronFactory = (_pattern, _options, handler) => {
    tick = handler;
    return { nextRun: () => new Date('2027-01-01T00:00:00Z'), stop: () => undefined };
  };
  const { schedule } = world.deps.config;
  const scheduler = await startScheduler({
    cron: schedule.cron,
    timeZone: schedule.timeZone,
    run: (weekId, signal, attempt) =>
      runDigest(world.deps, { weekId, signal, notifyFailure: attempt?.notifyFailure }),
    // Sent, so the start does not catch up; the test fires the tick itself.
    runStatus: () => Promise.resolve('sent'),
    clock: world.deps.clock,
    logger: world.deps.logger,
    failedRetry: DEFAULT_FAILED_RETRY,
    onGiveUp: (weekId, lastResult) => sendHeldNote(world.deps, weekId, lastResult.record),
    cronFactory,
    ...overrides,
  });
  handles.push(scheduler);
  return { tick: () => tick(), scheduler };
}

const DOWN: ModelHealth = { reachable: false, models: [], error: 'connection refused' };
const RETRYING = 'The run ended failed; will retry';

/** The message of each failure note, per channel. */
function noteMessages(world: World): string[][] {
  return world.deliveries.map((delivery) => delivery.failures.map((note) => note.message));
}

const noteCounts = (world: World): number[] =>
  world.deliveries.map((delivery) => delivery.failures.length);

/** Waits (in real time) until the scheduler has logged `count` retries of a failed run. */
async function untilRetries(world: World, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(world.logs.filter((line) => line.message === RETRYING)).toHaveLength(count);
  });
}

/** Waits (in real time) until the world has logged `message` `count` times. */
async function untilLogged(world: World, message: string, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(world.logs.filter((line) => line.message === message)).toHaveLength(count);
  });
}

const LOCK_RETRYING = 'Another run holds the lock; will retry';

afterEach(() => {
  for (const handle of handles.splice(0)) handle.stop();
  vi.useRealTimers();
});

describe('scheduler with the real run and store', () => {
  it(
    'ends a run that overran its limit as failed, says why in run.json and does not retry it',
    async () => {
      vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
      let enterHealth = (): void => undefined;
      const inHealth = new Promise<void>((resolve) => (enterHealth = resolve));
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        // A model that takes four hours to answer its health check, with the run holding its lock.
        model: ({ fake }) => ({
          generate: (request) => fake.generate(request),
          decide: (request) => fake.decide(request),
          health: async () => {
            enterHealth();
            await new Promise((resolve) => setTimeout(resolve, 4 * HOUR_MS));
            return fake.health();
          },
        }),
      });
      const service = await serve(world);

      const running = service.tick();
      await inHealth;
      await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
      await vi.advanceTimersByTimeAsync(4 * HOUR_MS);
      await running;
      await vi.advanceTimersByTimeAsync(24 * HOUR_MS);

      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('failed');
      expect(record.error?.message).toBe(
        'Run aborted before the collect step: run timed out after 3 h',
      );
      expect(world.rss.calls).toEqual([]);
      expect(await lockExists(dataDir())).toBe(false);
      // The attempt was told its failure would be retried, yet nobody will retry a timeout.
      expect(noteMessages(world)).toEqual([
        ['Run aborted before the collect step: run timed out after 3 h'],
        ['Run aborted before the collect step: run timed out after 3 h'],
        ['Run aborted before the collect step: run timed out after 3 h'],
      ]);
      const messages = world.logs.map((line) => line.message);
      expect(messages).toContain('Scheduled run hit its time limit; asking it to stop');
      expect(messages).toContain('Not retrying a run that hit its time limit');
      expect(messages.filter((message) => message === 'Scheduled run finished')).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
  it(
    'does not retry a week whose resume only --force can clear, through the real resume check',
    async () => {
      // A week that reached only the Markdown channel, then someone replaced its digest.md.
      const first = createWorld({ now: FRIDAY, dataDir: dataDir() });
      const email = first.deliveries.find((delivery) => delivery.id === 'email');
      if (!email) throw new Error('The world has no email channel');
      email.failWith = new Error('SMTP delivery failed: Connection timeout');
      await runDigest(first.deps, { weekId: WEEK });
      await writeFile(
        runFile(dataDir(), WEEK, 'digest.md'),
        '# Another\n\n[Source](https://x.test/o)\n',
        'utf8',
      );
      vi.useFakeTimers({
        now: new Date('2026-10-17T10:00:00Z'),
        toFake: ['setTimeout', 'clearTimeout'],
      });
      const later = createWorld({ now: '2026-10-17T10:00:00Z', dataDir: dataDir() });
      const service = await serve(later);

      await service.tick();
      await vi.advanceTimersByTimeAsync(24 * HOUR_MS);

      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('failed');
      expect(record.error?.message).toContain('--force');
      // Nobody will retry it, so its one note goes out on the first attempt.
      expect(later.deliveries.map((delivery) => delivery.failures.length)).toEqual([1, 1, 1]);
      const messages = later.logs.map((line) => line.message);
      expect(messages.filter((message) => message === 'Scheduled run finished')).toHaveLength(1);
      expect(messages).toContain('Not retrying: finishing this week needs "digest run --force"');
      expect(messages).not.toContain('The run ended failed; will retry');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'retries a week that ended failed on a transient error, and resumes the channels it missed',
    async () => {
      const first = createWorld({ now: FRIDAY, dataDir: dataDir() });
      const email = first.deliveries.find((delivery) => delivery.id === 'email');
      if (!email) throw new Error('The world has no email channel');
      email.failWith = new Error('SMTP delivery failed: Connection timeout');
      await runDigest(first.deps, { weekId: WEEK });
      vi.useFakeTimers({
        now: new Date('2026-10-17T10:00:00Z'),
        toFake: ['setTimeout', 'clearTimeout'],
      });
      // The mail server is back by the time the service tries again.
      const later = createWorld({ now: '2026-10-17T10:00:00Z', dataDir: dataDir() });
      const service = await serve(later);

      const running = service.tick();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await running;

      expect((await readRunJson(dataDir(), WEEK)).status).toBe('sent');
      expect(later.deliveries.map((delivery) => delivery.digests.length)).toEqual([0, 1, 0]); // only the email channel was missing
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sends one failure note for a week that keeps failing, from the last attempt',
    async () => {
      vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
      const world = createWorld({ now: FRIDAY, dataDir: dataDir(), health: DOWN });
      const service = await serve(world);

      const running = service.tick();
      await untilRetries(world, 1);
      expect(noteCounts(world)).toEqual([0, 0, 0]);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await untilRetries(world, 2);
      expect(noteCounts(world)).toEqual([0, 0, 0]);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await running;

      expect(noteMessages(world).map((notes) => notes.length)).toEqual([1, 1, 1]);
      expect(noteMessages(world)[0]?.[0]).toContain('Ollama is not reachable');
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('failed');
      const messages = world.logs.map((line) => line.message);
      expect(messages.filter((message) => message === 'Scheduled run finished')).toHaveLength(3);
      expect(messages.filter((message) => message.startsWith('Failure note held'))).toHaveLength(2);
      expect(messages).toContain('Scheduled run gave up: the run kept failing');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sends no failure note at all when the retry recovers the week',
    async () => {
      vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
      let ollamaIsUp = false;
      const world = createWorld({
        now: FRIDAY,
        dataDir: dataDir(),
        // Ollama is down for the first attempt and back for the retry.
        model: ({ fake }) => ({
          generate: (request) => fake.generate(request),
          decide: (request) => fake.decide(request),
          health: () => (ollamaIsUp ? fake.health() : Promise.resolve(DOWN)),
        }),
      });
      const service = await serve(world);

      const running = service.tick();
      await untilRetries(world, 1);
      ollamaIsUp = true;
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await running;

      expect(noteCounts(world)).toEqual([0, 0, 0]);
      expect((await readRunJson(dataDir(), WEEK)).status).toBe('sent');
      expect(world.deliveries.map((delivery) => delivery.digests.length)).toEqual([1, 1, 1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'sends the note at once when the service retries nothing',
    async () => {
      const world = createWorld({ now: FRIDAY, dataDir: dataDir(), health: DOWN });
      const service = await serve(world, { failedRetry: undefined });

      await service.tick();

      expect(noteCounts(world)).toEqual([1, 1, 1]);
    },
    TEST_TIMEOUT_MS,
  );

  describe('a failed week never ends silently: one note, whichever way the retry is lost', () => {
    const OLLAMA_DOWN = 'Ollama is not reachable';

    function expectOneNoteEach(world: World): void {
      expect(noteCounts(world)).toEqual([1, 1, 1]);
      for (const messages of noteMessages(world)) expect(messages[0]).toContain(OLLAMA_DOWN);
    }

    it(
      'when stop() cancels the pending retry',
      async () => {
        vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
        const world = createWorld({ now: FRIDAY, dataDir: dataDir(), health: DOWN });
        const service = await serve(world);

        const running = service.tick();
        await untilRetries(world, 1);
        expect(noteCounts(world)).toEqual([0, 0, 0]);
        service.scheduler.stop();
        await running;
        await vi.advanceTimersByTimeAsync(10 * HOUR_MS);

        expectOneNoteEach(world);
        expect((await readRunJson(dataDir(), WEEK)).status).toBe('failed');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'when the lock stays held until the scheduler gives up',
      async () => {
        vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
        const world = createWorld({ now: FRIDAY, dataDir: dataDir(), health: DOWN });
        const lockRetry = { everyMs: 60_000, forMs: 180_000 };
        const service = await serve(world, { lockRetry });

        const running = service.tick();
        await untilRetries(world, 1);
        // Another process takes the lock before the retry.
        await writeLock(dataDir(), { pid: process.pid, runId: WEEK, startedAt: FRIDAY });
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        for (let wait = 1; wait <= 3; wait++) {
          await untilLogged(world, LOCK_RETRYING, wait);
          expect(noteCounts(world)).toEqual([0, 0, 0]);
          await vi.advanceTimersByTimeAsync(60_000);
        }
        await running;

        expect(world.logs.map((line) => line.message)).toContain(
          'Scheduled run gave up: another run kept the lock',
        );
        expectOneNoteEach(world);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'when the retry throws instead of running',
      async () => {
        vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
        const world = createWorld({ now: FRIDAY, dataDir: dataDir(), health: DOWN });
        let calls = 0;
        const service = await serve(world, {
          run: (weekId, signal, attempt) => {
            calls += 1;
            if (calls > 1) return Promise.reject(new Error('disk gone'));
            return runDigest(world.deps, { weekId, signal, notifyFailure: attempt?.notifyFailure });
          },
        });

        const running = service.tick();
        await untilRetries(world, 1);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        await running;

        expect(calls).toBe(2);
        expectOneNoteEach(world);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'with the note of the last failed attempt when two failed before the retry was lost',
      async () => {
        vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
        let reason = 'first';
        const world = createWorld({
          now: FRIDAY,
          dataDir: dataDir(),
          model: ({ fake }) => ({
            generate: (request) => fake.generate(request),
            decide: (request) => fake.decide(request),
            health: () =>
              Promise.resolve({
                ...DOWN,
                error: `${reason} connection refused`,
              } satisfies ModelHealth),
          }),
        });
        const service = await serve(world);

        const running = service.tick();
        await untilRetries(world, 1);
        reason = 'second';
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        await untilRetries(world, 2);
        service.scheduler.stop();
        await running;

        expect(noteCounts(world)).toEqual([1, 1, 1]);
        expect(noteMessages(world)[0]?.[0]).toContain('second connection refused');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'when the retry times out: the run sends that note and the held one is dropped',
      async () => {
        vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
        let healthChecks = 0;
        let enterHealth = (): void => undefined;
        const inRetryHealth = new Promise<void>((resolve) => (enterHealth = resolve));
        const world = createWorld({
          now: FRIDAY,
          dataDir: dataDir(),
          model: ({ fake }) => ({
            generate: (request) => fake.generate(request),
            decide: (request) => fake.decide(request),
            health: async () => {
              healthChecks += 1;
              if (healthChecks === 1) return DOWN;
              enterHealth();
              await new Promise((resolve) => setTimeout(resolve, 4 * HOUR_MS));
              return fake.health();
            },
          }),
        });
        const service = await serve(world);

        const running = service.tick();
        await untilRetries(world, 1);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        await inRetryHealth;
        await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
        await vi.advanceTimersByTimeAsync(4 * HOUR_MS);
        await running;

        expect(noteCounts(world)).toEqual([1, 1, 1]);
        expect(noteMessages(world)[0]?.[0]).toBe(
          'Run aborted before the collect step: run timed out after 3 h',
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'when the retry is a resume that only --force can clear: the run sends that note',
      async () => {
        vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
        const world = createWorld({ now: FRIDAY, dataDir: dataDir(), health: DOWN });
        const service = await serve(world);

        const running = service.tick();
        await untilRetries(world, 1);
        // The week has since reached one channel, but its digest.md is gone.
        const record = await readRunJson(dataDir(), WEEK);
        await world.store.saveRunRecord({ ...record, deliveredTo: ['markdown'] });
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        await running;

        expect(noteCounts(world)).toEqual([1, 1, 1]);
        expect(noteMessages(world)[0]?.[0]).toContain('--force');
        const messages = world.logs.map((line) => line.message);
        expect(messages).toContain('Not retrying: finishing this week needs "digest run --force"');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'when the retry cannot save its record: that note says so and the held one is dropped',
      async () => {
        vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
        const world = createWorld({ now: FRIDAY, dataDir: dataDir(), health: DOWN });
        let saves = 0;
        // The second record this service saves does not reach the disk.
        const inner = world.deps.store;
        const store: RunStore = {
          ...inner,
          saveRunRecord: (record) => {
            saves += 1;
            return saves === 2
              ? Promise.reject(new Error('disk full'))
              : inner.saveRunRecord(record);
          },
        };
        const service = await serve(world, {
          run: (weekId, signal, attempt) =>
            runDigest(
              { ...world.deps, store },
              { weekId, signal, notifyFailure: attempt?.notifyFailure },
            ),
        });

        const running = service.tick();
        await untilRetries(world, 1);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        await running;

        expect(saves).toBe(2);
        expect(noteCounts(world)).toEqual([1, 1, 1]);
        expect(noteMessages(world)[0]?.[0]).toContain('Could not save the run record (disk full)');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'but not twice: a service stopped after its last attempt already sent the only note',
      async () => {
        vi.useFakeTimers({ now: new Date(FRIDAY), toFake: ['setTimeout', 'clearTimeout'] });
        const world = createWorld({ now: FRIDAY, dataDir: dataDir(), health: DOWN });
        const service = await serve(world);

        const running = service.tick();
        await untilRetries(world, 1);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        await untilRetries(world, 2);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        await running;
        service.scheduler.stop();
        await vi.advanceTimersByTimeAsync(HOUR_MS);

        expectOneNoteEach(world);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
