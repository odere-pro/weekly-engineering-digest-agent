// W5-09 (F13, F46): the scheduler's retry and run time limit through the real runDigest and the real run store,
// with the wiring `digest serve` uses. Only time is faked.
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDigest } from '../../src/core/runDigest.js';
import {
  DEFAULT_FAILED_RETRY,
  startScheduler,
  type CronFactory,
  type SchedulerHandle,
} from '../../src/scheduler/scheduler.js';
import {
  FRIDAY,
  TEST_TIMEOUT_MS,
  WEEK,
  createWorld,
  lockExists,
  readRunJson,
  runFile,
  useDataDir,
  type World,
} from '../integration/harness.js';

const HOUR_MS = 3_600_000;
const dataDir = useDataDir();
const handles: SchedulerHandle[] = [];

/** The service's wiring from `digest serve`, with a tick the test fires itself. */
async function serve(world: World): Promise<{ tick: () => Promise<void> }> {
  let tick: () => Promise<void> = () => Promise.resolve();
  const cronFactory: CronFactory = (_pattern, _options, handler) => {
    tick = handler;
    return { nextRun: () => new Date('2027-01-01T00:00:00Z'), stop: () => undefined };
  };
  const { schedule } = world.deps.config;
  const scheduler = await startScheduler({
    cron: schedule.cron,
    timeZone: schedule.timeZone,
    run: (weekId, signal) => runDigest(world.deps, { weekId, signal }),
    // Sent, so the start does not catch up; the test fires the tick itself.
    runStatus: () => Promise.resolve('sent'),
    clock: world.deps.clock,
    logger: world.deps.logger,
    failedRetry: DEFAULT_FAILED_RETRY,
    cronFactory,
  });
  handles.push(scheduler);
  return { tick: () => tick() };
}

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
});
