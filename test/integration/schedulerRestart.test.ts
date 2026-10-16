// Spec phase 4 exit gate, part 4: survives a missed week and a restart with no manual work.
// The real scheduler and run store, runDigest on fakes, croner's schedule maths with ticks fired
// by hand and a clock the test controls.
import { hostname } from 'node:os';
import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import { runDigest } from '../../src/core/runDigest.js';
import { ExitCode } from '../../src/core/schemas.js';
import type { Clock } from '../../src/shared/clock.js';
import {
  startScheduler,
  type CronFactory,
  type SchedulerHandle,
} from '../../src/scheduler/scheduler.js';
import {
  TEST_TIMEOUT_MS,
  FRIDAY,
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
function start(world: World, cron: ManualCron): Promise<SchedulerHandle> {
  const { schedule } = world.deps.config;
  return startScheduler({
    cron: schedule.cron,
    timeZone: schedule.timeZone,
    run: (weekId) => runDigest(world.deps, { weekId }),
    hasSentDigest: (weekId) => world.store.hasSentDigest(weekId),
    clock: world.deps.clock,
    logger: world.deps.logger,
    cronFactory: cron.factory,
  });
}

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
});
