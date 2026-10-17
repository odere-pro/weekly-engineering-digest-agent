import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { serveCommand, waitForShutdownSignal, type ServeCommandIo } from '../../src/cli/serve.js';
import type { AppHandle } from '../../src/app/container.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { PROFILES } from '../../src/config/profiles.js';
import type { DigestDeps, RunResult } from '../../src/core/runDigest.js';
import { ExitCode } from '../../src/core/schemas.js';
import {
  DEFAULT_FAILED_RETRY,
  type SchedulerHandle,
  type SchedulerOptions,
} from '../../src/scheduler/scheduler.js';
import { DigestError } from '../../src/shared/errors.js';
import type { Logger } from '../../src/shared/telemetry.js';
import { makeConfig, makeRunRecord } from '../builders.js';
import { FakeModelProvider, MemoryRunStore, fixedClock } from '../fakes/index.js';

const NEXT_RUN = new Date('2026-10-19T05:45:00Z');

interface MockLogger extends Logger {
  debug: Mock<Logger['debug']>;
  info: Mock<Logger['info']>;
  warn: Mock<Logger['warn']>;
  error: Mock<Logger['error']>;
}

function mockLogger(): MockLogger {
  const logger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

interface Harness {
  io: ServeCommandIo;
  deps: DigestDeps;
  store: MemoryRunStore;
  logger: MockLogger;
  stderr: string[];
  events: string[];
  schedulerStop: Mock<() => void>;
  whenIdle: Mock<() => Promise<void>>;
  nextRun: Mock<SchedulerHandle['nextRun']>;
  startScheduler: Mock<ServeCommandIo['startScheduler']>;
  runDigest: Mock<ServeCommandIo['runDigest']>;
  loadConfig: Mock<ServeCommandIo['loadConfig']>;
  buildApp: Mock<ServeCommandIo['buildApp']>;
  close: Mock<AppHandle['close']>;
  /** What each `waitForSignal` call was given to stop listening, in call order. */
  cancels: (AbortSignal | undefined)[];
  /** Delivers a shutdown signal to the command's latest wait for one. */
  signal: (name?: NodeJS.Signals) => void;
}

function harness(overrides: Partial<ServeCommandIo> = {}): Harness {
  const events: string[] = [];
  const cancels: (AbortSignal | undefined)[] = [];
  const stderr: string[] = [];
  const logger = mockLogger();
  const store = new MemoryRunStore();
  const config = makeConfig({ schedule: { cron: '15 6 * * 2', timeZone: 'Europe/Berlin' } });
  const loaded: LoadedConfig = {
    config,
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: {},
    profile: PROFILES.quality,
    platform: { os: 'darwin', arch: 'arm64' },
    configPath: '/work/digest.config.json',
  };
  const deps: DigestDeps = {
    config,
    profile: PROFILES.quality,
    model: new FakeModelProvider(),
    fetchers: {},
    inputGuards: [],
    outputGuards: [],
    deliveries: [],
    store,
    logger,
    tracer: { span: (_name, _attributes, fn) => fn() },
    clock: fixedClock('2026-10-14T10:00:00Z'),
  };
  const close = vi.fn<AppHandle['close']>(() => {
    events.push('close');
    return Promise.resolve();
  });
  const schedulerStop = vi.fn(() => {
    events.push('stop');
  });
  const whenIdle = vi.fn<() => Promise<void>>(() => {
    events.push('idle');
    return Promise.resolve();
  });
  const nextRun = vi.fn<SchedulerHandle['nextRun']>(() => NEXT_RUN);
  const handle: SchedulerHandle = { nextRun, stop: schedulerStop, whenIdle };
  const runResult: RunResult = { record: makeRunRecord(), exitCode: ExitCode.Sent };
  const loadConfig = vi.fn<ServeCommandIo['loadConfig']>(() => Promise.resolve(loaded));
  const buildApp = vi.fn<ServeCommandIo['buildApp']>(() => Promise.resolve({ deps, close }));
  const startScheduler = vi.fn<ServeCommandIo['startScheduler']>(() => Promise.resolve(handle));
  const runDigest = vi.fn<ServeCommandIo['runDigest']>(() => Promise.resolve(runResult));
  let deliver: (name: NodeJS.Signals) => void = () => undefined;
  const io: ServeCommandIo = {
    loadConfig,
    buildApp,
    startScheduler,
    runDigest,
    waitForSignal: (cancel) => {
      events.push('listen');
      cancels.push(cancel);
      return new Promise((resolve) => (deliver = resolve));
    },
    stderr: (text) => stderr.push(text),
    ...overrides,
  };
  return {
    io,
    deps,
    store,
    logger,
    stderr,
    events,
    schedulerStop,
    whenIdle,
    nextRun,
    startScheduler,
    runDigest,
    loadConfig,
    buildApp,
    close,
    cancels,
    signal: (name = 'SIGTERM') => {
      deliver(name);
    },
  };
}

/** Runs the command and returns its exit code once the signal has been delivered. */
async function serveUntilSignal(h: Harness, signal?: NodeJS.Signals): Promise<number> {
  const pending = serveCommand({ config: '/work/digest.config.json' }, h.io);
  await vi.waitFor(() => {
    expect(h.startScheduler).toHaveBeenCalled();
  });
  h.signal(signal);
  return pending;
}

describe('serveCommand wiring', () => {
  it('loads the config from the given path and builds the app from it', async () => {
    const h = harness();

    await serveUntilSignal(h);

    expect(h.loadConfig).toHaveBeenCalledWith({ configPath: '/work/digest.config.json' });
    expect(h.buildApp).toHaveBeenCalledWith(await h.loadConfig.mock.results[0]?.value);
  });

  it('starts the scheduler with the configured cron and time zone', async () => {
    const h = harness();

    await serveUntilSignal(h);

    const options = h.startScheduler.mock.calls[0]?.[0] as SchedulerOptions;
    expect(options.cron).toBe('15 6 * * 2');
    expect(options.timeZone).toBe('Europe/Berlin');
    expect(options.clock).toBe(h.deps.clock);
    expect(options.logger).toBe(h.logger);
  });

  it('asks the scheduler to retry a failed run, as the service does', async () => {
    const h = harness();

    await serveUntilSignal(h);

    const options = h.startScheduler.mock.calls[0]?.[0] as SchedulerOptions;
    expect(options.failedRetry).toBe(DEFAULT_FAILED_RETRY);
  });

  it('runs the digest for the week the scheduler asks for', async () => {
    const h = harness();
    await serveUntilSignal(h);
    const options = h.startScheduler.mock.calls[0]?.[0] as SchedulerOptions;

    const result = await options.run('2026-W42', new AbortController().signal);

    expect(h.runDigest).toHaveBeenCalledExactlyOnceWith(h.deps, {
      weekId: '2026-W42',
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(result.exitCode).toBe(ExitCode.Sent);
  });

  it('asks the run store how a week ended', async () => {
    const h = harness();
    h.store.records.set('2026-W42', makeRunRecord({ runId: '2026-W42', status: 'quiet' }));
    await serveUntilSignal(h);
    const options = h.startScheduler.mock.calls[0]?.[0] as SchedulerOptions;

    await expect(options.runStatus('2026-W42')).resolves.toBe('quiet');
    await expect(options.runStatus('2026-W41')).resolves.toBeUndefined();
  });

  it('logs when the scheduler is up and when it stops', async () => {
    const h = harness();

    await serveUntilSignal(h, 'SIGINT');

    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('started'),
      expect.objectContaining({
        cron: '15 6 * * 2',
        timeZone: 'Europe/Berlin',
        nextRun: NEXT_RUN.toISOString(),
      }),
    );
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('stopping'),
      expect.objectContaining({ signal: 'SIGINT' }),
    );
  });
});

describe('serveCommand shutdown', () => {
  it('stops the scheduler, then closes the app, then returns 0', async () => {
    const h = harness();

    const code = await serveUntilSignal(h);

    expect(code).toBe(0);
    expect(h.events).toEqual(['listen', 'stop', 'idle', 'listen', 'close']);
  });

  it('keeps the service up until a signal arrives', async () => {
    const h = harness();
    let settled = false;
    const pending = serveCommand({}, h.io).then((code) => {
      settled = true;
      return code;
    });
    await vi.waitFor(() => {
      expect(h.startScheduler).toHaveBeenCalled();
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(h.schedulerStop).not.toHaveBeenCalled();

    h.signal();
    await expect(pending).resolves.toBe(0);
  });

  it('waits for a running digest before it closes the app', async () => {
    const h = harness();
    let finish: () => void = () => undefined;
    h.whenIdle.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const pending = serveUntilSignal(h);
    await vi.waitFor(() => {
      expect(h.schedulerStop).toHaveBeenCalled();
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.close).not.toHaveBeenCalled();

    finish();
    await expect(pending).resolves.toBe(0);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('listens for signals before it loads the config', async () => {
    const h = harness();
    h.loadConfig.mockImplementation(() => {
      h.events.push('load');
      return Promise.reject(new DigestError('stop here'));
    });

    await serveCommand({}, h.io);

    expect(h.events.slice(0, 2)).toEqual(['listen', 'load']);
  });

  it('warns when the schedule has no upcoming run', async () => {
    const h = harness();
    h.nextRun.mockReturnValue(null);

    await serveUntilSignal(h);

    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no upcoming run'),
      expect.objectContaining({ cron: '15 6 * * 2' }),
    );
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('started'),
      expect.objectContaining({ nextRun: null }),
    );
  });

  it('logs a failing close and still returns 0', async () => {
    const h = harness();
    h.close.mockRejectedValueOnce(new Error('flush failed'));

    const code = await serveUntilSignal(h);

    expect(code).toBe(0);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('close'),
      expect.objectContaining({ error: 'flush failed' }),
    );
  });
});

describe('serveCommand run signal', () => {
  /** Starts a run the way the scheduler does; returns the signal the digest was given. */
  function startRun(h: Harness, limit = new AbortController()): AbortSignal {
    const options = h.startScheduler.mock.calls[0]?.[0] as SchedulerOptions;
    void options.run('2026-W42', limit.signal);
    const given = h.runDigest.mock.calls.at(-1)?.[1]?.signal;
    if (!given) throw new Error('runDigest was not given a signal');
    return given;
  }

  async function serving(h: Harness): Promise<{ pending: Promise<number> }> {
    const pending = serveCommand({}, h.io);
    await vi.waitFor(() => {
      expect(h.startScheduler).toHaveBeenCalled();
    });
    return { pending };
  }

  it('hands the scheduler time limit on to the digest', async () => {
    const h = harness();
    const { pending } = await serving(h);
    const limit = new AbortController();
    const given = startRun(h, limit);
    expect(given.aborted).toBe(false);

    const reason = new Error('run timed out after 3 h');
    limit.abort(reason);

    expect(given.aborted).toBe(true);
    expect(given.reason).toBe(reason);
    h.signal();
    await pending;
  });

  it('leaves the digest running after the first signal and stops it on the second', async () => {
    const h = harness();
    let finish: () => void = () => undefined;
    h.whenIdle.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const { pending } = await serving(h);
    const given = startRun(h);

    h.signal('SIGTERM');
    await vi.waitFor(() => {
      expect(h.cancels).toHaveLength(2);
    });
    expect(given.aborted).toBe(false);

    h.signal('SIGINT');
    await vi.waitFor(() => {
      expect(given.aborted).toBe(true);
    });
    expect(String(given.reason)).toContain('asked to stop again (SIGINT)');
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Second signal'),
      expect.objectContaining({ signal: 'SIGINT' }),
    );
    expect(h.close).not.toHaveBeenCalled();

    finish();
    await expect(pending).resolves.toBe(0);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('does not touch a digest that finishes before a second signal', async () => {
    const h = harness();
    let finish: () => void = () => undefined;
    h.whenIdle.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const { pending } = await serving(h);
    const given = startRun(h);
    h.signal();
    await vi.waitFor(() => {
      expect(h.cancels).toHaveLength(2);
    });
    expect(h.cancels[1]?.aborted).toBe(false);

    finish();
    await expect(pending).resolves.toBe(0);

    expect(given.aborted).toBe(false);
    expect(h.cancels[1]?.aborted).toBe(true);
  });

  it('listens for the first signal without a way to cancel it', async () => {
    const h = harness();

    await serveUntilSignal(h);

    expect(h.cancels[0]).toBeUndefined();
  });
});

describe('serveCommand failures', () => {
  it('prints a config error and returns its exit code without building the app', async () => {
    const h = harness();
    h.loadConfig.mockRejectedValue(
      new DigestError('No digest.config.json found. Run "digest init".'),
    );

    const code = await serveCommand({}, h.io);

    expect(code).toBe(ExitCode.Failed);
    expect(h.stderr.join('')).toContain('Run "digest init"');
    expect(h.buildApp).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
  });

  it('closes the app and returns the exit code when the scheduler cannot start', async () => {
    const h = harness();
    h.startScheduler.mockRejectedValue(new DigestError('Invalid schedule', { exitCode: 2 }));

    const code = await serveCommand({}, h.io);

    expect(code).toBe(2);
    expect(h.stderr.join('')).toContain('Invalid schedule');
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('rethrows an unexpected error after closing the app', async () => {
    const h = harness();
    h.startScheduler.mockRejectedValue(new TypeError('bug'));

    await expect(serveCommand({}, h.io)).rejects.toThrow('bug');

    expect(h.close).toHaveBeenCalledOnce();
  });
});

describe('waitForShutdownSignal', () => {
  const before = {
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM'),
  };

  afterEach(() => {
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
  });

  it('resolves with SIGTERM and removes both listeners', async () => {
    const pending = waitForShutdownSignal();
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);

    process.emit('SIGTERM');

    await expect(pending).resolves.toBe('SIGTERM');
  });

  it('resolves with SIGINT and removes both listeners', async () => {
    const pending = waitForShutdownSignal();

    process.emit('SIGINT');

    await expect(pending).resolves.toBe('SIGINT');
  });

  it('stops listening when the cancel signal fires, and never settles', async () => {
    const cancel = new AbortController();
    let settled = false;
    void waitForShutdownSignal(cancel.signal).then(() => {
      settled = true;
    });
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);

    cancel.abort();

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
  });

  it('does not listen at all when the cancel signal has already fired', () => {
    const cancel = new AbortController();
    cancel.abort();

    void waitForShutdownSignal(cancel.signal);

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
  });

  it('forgets the cancel signal once a signal arrived', async () => {
    const cancel = new AbortController();
    const pending = waitForShutdownSignal(cancel.signal);

    process.emit('SIGINT');
    await expect(pending).resolves.toBe('SIGINT');
    cancel.abort();

    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
  });
});
