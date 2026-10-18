// W5-12: `digest serve` passes the scheduler's attempt on to the run, and sends the failure note a
// failed week held back when no retry will run.
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { AppHandle } from '../../app/container';
import type { LoadedConfig } from '../../config/load';
import { PROFILES } from '../../config/profiles';
import type { DigestDeps, RunResult } from '../../digest/runDigest';
import { ExitCode } from '../../domain/schemas';
import { serveCommand, type ServeCommandIo } from './serve';
import type { SchedulerHandle, SchedulerOptions } from '../../scheduler/scheduler';
import type { LogFields, Logger } from '../../shared/telemetry';
import { makeConfig, makeRunRecord } from '../../../test/builders';
import {
  CapturingDelivery,
  FakeModelProvider,
  MemoryRunStore,
  fixedClock,
} from '../../../test/fakes';

const WEEK = '2026-W42';

interface LogLine {
  message: string;
  fields: LogFields;
}

function recordingLogger(lines: LogLine[]): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message, fields = {}) => void lines.push({ message, fields }),
    child: () => logger,
  };
  return logger;
}

function setup() {
  const errors: LogLine[] = [];
  const deliveries = [new CapturingDelivery('markdown'), new CapturingDelivery('email')];
  const config = makeConfig({ schedule: { cron: '15 6 * * 2', timeZone: 'Europe/Berlin' } });
  const deps: DigestDeps = {
    config,
    profile: PROFILES.quality,
    model: new FakeModelProvider(),
    fetchers: {},
    inputGuards: [],
    outputGuards: [],
    deliveries,
    store: new MemoryRunStore(),
    logger: recordingLogger(errors),
    tracer: { span: (_name, _attributes, fn) => fn() },
    clock: fixedClock('2026-10-14T10:00:00Z'),
  };
  const loaded: LoadedConfig = {
    config,
    env: { OLLAMA_URL: 'http://localhost:11434', LOG_LEVEL: 'info' },
    secrets: {},
    profile: PROFILES.quality,
    platform: { os: 'darwin', arch: 'arm64' },
    configPath: '/work/digest.config.json',
  };
  const handle: SchedulerHandle = {
    nextRun: () => new Date('2026-10-20T04:15:00Z'),
    stop: () => undefined,
    whenIdle: () => Promise.resolve(),
  };
  const runResult: RunResult = { record: makeRunRecord(), exitCode: ExitCode.Sent };
  const runDigest = vi.fn<ServeCommandIo['runDigest']>(() => Promise.resolve(runResult));
  const startScheduler = vi.fn<ServeCommandIo['startScheduler']>(() => Promise.resolve(handle));
  let deliver: (name: NodeJS.Signals) => void = () => undefined;
  const io: ServeCommandIo = {
    loadConfig: () => Promise.resolve(loaded),
    buildApp: (): Promise<AppHandle> => Promise.resolve({ deps, close: () => Promise.resolve() }),
    startScheduler,
    runDigest,
    waitForSignal: () => new Promise((resolve) => (deliver = resolve)),
    stderr: () => undefined,
  };
  return {
    io,
    deliveries,
    errors,
    runDigest,
    startScheduler,
    stop: () => {
      deliver('SIGTERM');
    },
  };
}

/** Starts the service and hands back the options it gave the scheduler. */
async function serving(h: ReturnType<typeof setup>): Promise<{
  options: SchedulerOptions;
  finish: () => Promise<number>;
}> {
  const pending = serveCommand({}, h.io);
  await vi.waitFor(() => {
    expect(h.startScheduler).toHaveBeenCalled();
  });
  const options = (h.startScheduler as Mock).mock.calls[0]?.[0] as SchedulerOptions;
  return {
    options,
    finish: () => {
      h.stop();
      return pending;
    },
  };
}

describe('serve: the attempt reaches the run', () => {
  it.each([true, false])('passes notifyFailure %s on to runDigest', async (notifyFailure) => {
    const h = setup();
    const { options, finish } = await serving(h);

    await options.run(WEEK, new AbortController().signal, { notifyFailure });

    expect(h.runDigest).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ weekId: WEEK, notifyFailure }),
    );
    await finish();
  });

  it('leaves the default when the scheduler gives no attempt', async () => {
    const h = setup();
    const { options, finish } = await serving(h);

    await options.run(WEEK, new AbortController().signal);

    expect(h.runDigest.mock.calls[0]?.[1]?.notifyFailure).toBeUndefined();
    await finish();
  });
});

describe('serve: the held failure note', () => {
  const heldRecord = makeRunRecord({
    runId: WEEK,
    status: 'failed',
    error: { message: 'Ollama is not reachable', step: 'write' },
  });
  const lastResult: RunResult = { record: heldRecord, exitCode: ExitCode.Failed };

  it('gives the scheduler a way to send it, so it holds a note back at all', async () => {
    const h = setup();
    const { options, finish } = await serving(h);

    expect(options.onGiveUp).toBeTypeOf('function');
    await finish();
  });

  it('sends the note of the last failed result to every channel, once', async () => {
    const h = setup();
    const { options, finish } = await serving(h);

    await options.onGiveUp?.(WEEK, lastResult);

    for (const delivery of h.deliveries) {
      expect(delivery.failures).toEqual([
        { weekId: WEEK, step: 'write', message: 'Ollama is not reachable' },
      ]);
    }
    await finish();
  });

  it('does not reject when a channel cannot take the note, and still tries the others', async () => {
    const h = setup();
    const [first] = h.deliveries;
    if (first) first.sendFailure = () => Promise.reject(new Error('mail server is down'));
    const { options, finish } = await serving(h);

    await expect(options.onGiveUp?.(WEEK, lastResult)).resolves.toBeUndefined();

    expect(h.deliveries[1]?.failures).toHaveLength(1);
    expect(h.errors).toContainEqual({
      message: 'Could not send the failure note',
      fields: { delivery: 'markdown', error: 'mail server is down' },
    });
    await finish();
  });
});
