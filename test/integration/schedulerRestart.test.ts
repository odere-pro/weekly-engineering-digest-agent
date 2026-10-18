// Spec phase 4 exit gate, part 4: survives a missed week and a restart with no manual work.
// The real scheduler and run store, runDigest on fakes, croner's schedule maths with ticks fired
// by hand and a clock the test controls.
import { hostname } from 'node:os';
import { Cron } from 'croner';
import { describe, expect, it, vi } from 'vitest';
import { QUESTION_IDS } from '../../src/core/prompts/classify.js';
import { runDigest } from '../../src/core/runDigest.js';
import { ExitCode } from '../../src/core/schemas.js';
import type { Clock } from '../../src/shared/clock.js';
import {
  startScheduler,
  type CronFactory,
  type LockRetry,
  type SchedulerHandle,
} from '../../src/scheduler/scheduler.js';
import { FakeOutputGuard } from '../fakes/index.js';
import {
  TEST_TIMEOUT_MS,
  FRIDAY,
  IRRELEVANT_ANSWER,
  WEEK,
  createWorld,
  lockExists,
  readRunJson,
  runCli,
  useDataDir,
  type World,
  type WorldOptions,
} from './harness.js';

const dataDir = useDataDir();

/** Mondays 07:45 in Europe/Berlin is 05:45 UTC in October; Wednesday is after that slot. */
const MONDAY_BEFORE_SLOT = '2026-10-12T04:00:00Z';
const MONDAY_SLOT = '2026-10-12T05:45:00Z';
const WEDNESDAY = '2026-10-14T10:00:00Z';

const digestsSent = (world: World): number[] => world.deliveries.map((d) => d.digests.length);
const messages = (world: World): string[] => world.logs.map((line) => line.message);

interface ManualCron {
  readonly factory: CronFactory;
  /** Fires the job's handler as croner would at the slot. */
  tick(): Promise<void>;
  /** The job's next slot after `from`, by the pattern and time zone the scheduler gave it. */
  nextSlotAfter(from: Date): Date | null;
}

/** croner's schedule maths, never its timer: the test decides when a tick happens. */
function manualCron(): ManualCron {
  let handler: (() => Promise<void>) | undefined;
  let job: Cron | undefined;
  const factory: CronFactory = (pattern, options, run) => {
    handler = run;
    job = new Cron(pattern, { timezone: options.timezone, paused: true });
    return job;
  };
  return {
    factory,
    tick: () => (handler ? handler() : Promise.reject(new Error('The scheduler made no job'))),
    nextSlotAfter: (from) => job?.nextRun(from) ?? null,
  };
}

interface Gate {
  /** A model whose health check waits at the gate, with the run holding its lock. */
  readonly model: NonNullable<WorldOptions['model']>;
  /** Resolves once a run is waiting at the gate. */
  readonly entered: Promise<void>;
  open(): void;
}

function healthGate(): Gate {
  let open = (): void => undefined;
  let enter = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    open = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  return {
    entered,
    open: () => {
      open();
    },
    model: ({ fake }) => ({
      generate: (request) => fake.generate(request),
      decide: (request) => fake.decide(request),
      health: async () => {
        enter();
        await closed;
        return fake.health();
      },
    }),
  };
}

/** The service's wiring from `digest serve`: runDigest per week, the store for catch-up. */
function start(world: World, cron: ManualCron, lockRetry?: LockRetry): Promise<SchedulerHandle> {
  const { schedule } = world.deps.config;
  return startScheduler({
    ...(lockRetry && { lockRetry }),
    cron: schedule.cron,
    timeZone: schedule.timeZone,
    run: (weekId) => runDigest(world.deps, { weekId }),
    runStatus: async (weekId) => (await world.store.getRunRecord(weekId))?.status,
    clock: world.deps.clock,
    logger: world.deps.logger,
    cronFactory: cron.factory,
  });
}

/** Starts the service on Wednesday, lets its catch-up run, and stops it. */
async function serveOnce(
  options: Partial<WorldOptions> = {},
  prepare: (world: World) => void = () => undefined,
): Promise<World> {
  const world = createWorld({ now: WEDNESDAY, dataDir: dataDir(), ...options });
  prepare(world);
  const scheduler = await start(world, manualCron());
  await scheduler.whenIdle();
  scheduler.stop();
  return world;
}

/** The service restarted on Friday, after its catch-up finished. */
async function restart(): Promise<World> {
  const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
  const scheduler = await start(world, manualCron());
  await scheduler.whenIdle();
  scheduler.stop();
  return world;
}

const modelCalls = (world: World): number =>
  world.fake.decideCalls.length + world.fake.generateCalls.length;

describe('integration: scheduler catch-up', () => {
  it(
    'runs the missed week once when the service starts after Monday',
    async () => {
      const world = createWorld({ now: WEDNESDAY, dataDir: dataDir() });

      const scheduler = await start(world, manualCron());
      await scheduler.whenIdle();
      scheduler.stop();

      expect(digestsSent(world)).toEqual([1, 1, 1]);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record).toMatchObject({ status: 'sent', startedAt: '2026-10-14T10:00:00.000Z' });
      const catchUps = world.logs.filter((line) => line.message === 'Catching up on a missed run');
      expect(catchUps).toHaveLength(1);
      expect(catchUps[0]?.fields).toMatchObject({ weekId: WEEK });
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not run the week again when the service restarts',
    async () => {
      const first = createWorld({ now: WEDNESDAY, dataDir: dataDir() });
      const scheduler = await start(first, manualCron());
      await scheduler.whenIdle();
      scheduler.stop();
      // A new process: nothing carries over but the files in the data dir.
      const restarted = createWorld({ now: FRIDAY, dataDir: dataDir() });

      const again = await start(restarted, manualCron());
      await again.whenIdle();
      again.stop();

      expect(digestsSent(first)).toEqual([1, 1, 1]);
      expect(digestsSent(restarted)).toEqual([0, 0, 0]);
      expect(restarted.rss.calls).toEqual([]);
      expect(restarted.fake.decideCalls).toEqual([]);
      expect(messages(restarted)).not.toContain('Catching up on a missed run');
      expect((await readRunJson(dataDir(), WEEK)).startedAt).toBe('2026-10-14T10:00:00.000Z');
    },
    TEST_TIMEOUT_MS,
  );

  it.each<[string, Partial<WorldOptions>]>([
    [
      'quiet',
      {
        decide: (request, valid) =>
          request.role === 'classify'
            ? { ...valid(), [QUESTION_IDS.relevance]: IRRELEVANT_ANSWER }
            : valid(),
      },
    ],
    [
      'blocked',
      {
        outputGuards: [
          new FakeOutputGuard('graniteGroundedness', () => true),
          new FakeOutputGuard('clefRubric'),
        ],
      },
    ],
  ])(
    'does not run a week that ended %s again when the service restarts',
    async (status, options) => {
      await serveOnce(options);
      const settled = await readRunJson(dataDir(), WEEK);
      expect(settled.status).toBe(status);

      const restarted = await restart();

      expect(restarted.rss.calls).toEqual([]);
      expect(modelCalls(restarted)).toBe(0);
      expect(digestsSent(restarted)).toEqual([0, 0, 0]);
      expect(messages(restarted)).not.toContain('Catching up on a missed run');
      expect(await readRunJson(dataDir(), WEEK)).toEqual(settled);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs a failed week again when the service restarts',
    async () => {
      await serveOnce({ health: { reachable: false, models: [], error: 'connection refused' } });
      expect((await readRunJson(dataDir(), WEEK)).status).toBe('failed');

      const restarted = await restart();

      expect(messages(restarted)).toContain('Catching up on a missed run');
      expect(digestsSent(restarted)).toEqual([1, 1, 1]);
      expect(await readRunJson(dataDir(), WEEK)).toMatchObject({
        status: 'sent',
        startedAt: new Date(FRIDAY).toISOString(),
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'finishes a partly delivered week when the service restarts, without the models',
    async () => {
      await serveOnce({}, (world) => {
        const slack = world.deliveries.find((delivery) => delivery.id === 'slack');
        if (!slack) throw new Error('The world has no slack channel');
        slack.failWith = new Error('webhook answered 500');
      });
      expect(await readRunJson(dataDir(), WEEK)).toMatchObject({
        status: 'failed',
        deliveredTo: ['markdown', 'email'],
      });

      const restarted = await restart();

      expect(messages(restarted)).toContain('Catching up on a missed run');
      expect(digestsSent(restarted)).toEqual([0, 0, 1]);
      expect(modelCalls(restarted)).toBe(0);
      expect(await readRunJson(dataDir(), WEEK)).toMatchObject({
        status: 'sent',
        deliveredTo: ['markdown', 'email', 'slack'],
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'waits for the slot when the service starts before Monday 07:45, then runs the week once',
    async () => {
      let current = new Date(MONDAY_BEFORE_SLOT);
      const clock: Clock = { now: () => new Date(current) };
      const world = createWorld({ now: MONDAY_BEFORE_SLOT, dataDir: dataDir(), clock });
      const cron = manualCron();

      const scheduler = await start(world, cron);
      await scheduler.whenIdle();
      expect(cron.nextSlotAfter(current)).toEqual(new Date(MONDAY_SLOT));
      expect(digestsSent(world)).toEqual([0, 0, 0]);

      current = new Date(MONDAY_SLOT);
      await cron.tick();
      expect(digestsSent(world)).toEqual([1, 1, 1]);
      expect(await readRunJson(dataDir(), WEEK)).toMatchObject({ status: 'sent' });

      // A second tick in the same week finds the sent record and does nothing.
      await cron.tick();
      scheduler.stop();
      expect(digestsSent(world)).toEqual([1, 1, 1]);
      const finished = world.logs.filter((line) => line.message === 'Scheduled run finished');
      expect(finished.map((line) => line.fields.status)).toEqual(['sent', 'skipped']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ignores a tick that arrives while the catch-up is still running',
    async () => {
      const gate = healthGate();
      const world = createWorld({ now: WEDNESDAY, dataDir: dataDir(), model: gate.model });
      const cron = manualCron();

      const scheduler = await start(world, cron);
      try {
        await gate.entered;
        await cron.tick();
        expect(messages(world)).toContain(
          'Skipped a scheduled run: the previous run is still going',
        );
      } finally {
        gate.open();
        await scheduler.whenIdle();
        scheduler.stop();
      }

      expect(digestsSent(world)).toEqual([1, 1, 1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a manual run while the catch-up holds the lock',
    async () => {
      const gate = healthGate();
      const service = createWorld({ now: WEDNESDAY, dataDir: dataDir(), model: gate.model });
      const scheduler = await start(service, manualCron());
      // `digest run` in another process: same data dir, its own fakes.
      const manual = createWorld({ now: WEDNESDAY, dataDir: dataDir() });

      let cli: Awaited<ReturnType<typeof runCli>>;
      try {
        await gate.entered;
        cli = await runCli(manual);
      } finally {
        gate.open();
        await scheduler.whenIdle();
        scheduler.stop();
      }

      expect(cli.exitCode).toBe(ExitCode.Failed);
      expect(cli.stderr).toContain(
        `Another run is in progress (pid ${process.pid}, host ${hostname()}, week ${WEEK})`,
      );
      expect(digestsSent(manual)).toEqual([0, 0, 0]);
      expect(digestsSent(service)).toEqual([1, 1, 1]);
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'retries a Monday tick that met a manual run, and sends the week once the lock is free',
    async () => {
      const gate = healthGate();
      // `digest run --dry-run` in another process holds the lock when Monday's tick comes. Both
      // processes read the same clock, so the lock's heartbeat is fresh.
      const manual = createWorld({
        now: MONDAY_BEFORE_SLOT,
        dataDir: dataDir(),
        model: gate.model,
      });
      const service = createWorld({ now: MONDAY_BEFORE_SLOT, dataDir: dataDir() });
      const cron = manualCron();
      const scheduler = await start(service, cron, { everyMs: 20, forMs: 5_000 });
      const dry = runCli(manual, { dryRun: true });
      try {
        await gate.entered;
        const tick = cron.tick();
        await vi.waitFor(() => {
          expect(messages(service)).toContain('Another run holds the lock; will retry');
        });
        gate.open();
        await dry;
        await tick;
      } finally {
        gate.open();
        await dry;
        scheduler.stop();
      }

      // A dry run now writes the local Markdown file (W8-05); email and Slack get nothing.
      expect(digestsSent(manual)).toEqual([1, 0, 0]);
      expect(digestsSent(service)).toEqual([1, 1, 1]);
      expect(await readRunJson(dataDir(), WEEK)).toMatchObject({ status: 'sent' });
      expect(messages(service)).not.toContain('Scheduled run gave up: another run kept the lock');
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
