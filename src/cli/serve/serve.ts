import { buildApp, type AppHandle } from '../../app/container';
import { loadConfig, type LoadedConfig } from '../../config/load';
import { runDigest } from '../../digest/runDigest';
import { sendHeldNote } from '../../digest/ending/notes/failureNotes';
import {
  DEFAULT_FAILED_RETRY,
  startScheduler,
  type SchedulerHandle,
} from '../../scheduler/scheduler';
import { DigestError, errorMessage } from '../../shared/errors';
import type { Logger } from '../../shared/telemetry';

export interface ServeCommandOptions {
  /** Path to digest.config.json. */
  config?: string;
}

/** Everything the command touches outside itself; tests replace it, `digest serve` uses the defaults. */
export interface ServeCommandIo {
  loadConfig: (options: { configPath?: string }) => Promise<LoadedConfig>;
  buildApp: (loaded: LoadedConfig) => Promise<AppHandle>;
  startScheduler: typeof startScheduler;
  runDigest: typeof runDigest;
  /**
   * Resolves with the next signal that asks the service to stop. Firing `cancel` stops the
   * listening; the promise then never settles.
   */
  waitForSignal: (cancel?: AbortSignal) => Promise<NodeJS.Signals>;
  stderr: (text: string) => void;
}

const EXIT_OK = 0;
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

const defaultIo: ServeCommandIo = {
  loadConfig: (options) => loadConfig(options),
  buildApp,
  startScheduler,
  runDigest,
  waitForSignal: waitForShutdownSignal,
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** `digest serve`: Runs the in-process weekly scheduler (Docker Compose service) (W1-16). Returns the process exit code. */
export async function serveCommand(
  options: ServeCommandOptions,
  overrides: Partial<ServeCommandIo> = {},
): Promise<number> {
  const io: ServeCommandIo = { ...defaultIo, ...overrides };
  // Listening from the start, so a signal during startup is not met by the default handler.
  const signalled = io.waitForSignal();
  let app: AppHandle | undefined;
  try {
    const loaded = await io.loadConfig({ configPath: options.config });
    app = await io.buildApp(loaded);
    await serveUntilSignal(io, loaded, app, signalled);
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof DigestError)) throw error;
    io.stderr(`${error.message}\n`);
    return error.exitCode;
  } finally {
    if (app) await closeApp(app);
  }
}

async function serveUntilSignal(
  io: ServeCommandIo,
  loaded: LoadedConfig,
  app: AppHandle,
  signalled: Promise<NodeJS.Signals>,
): Promise<void> {
  const { cron, timeZone } = loaded.config.schedule;
  const { deps } = app;
  // Fired by a second signal. The scheduler's own signal, its time limit, is the other way a run ends.
  const quitNow = new AbortController();
  const scheduler = await io.startScheduler({
    cron,
    timeZone,
    run: (weekId, limit, attempt) =>
      io.runDigest(deps, {
        weekId,
        signal: AbortSignal.any([limit, quitNow.signal]),
        // False on an attempt the scheduler will retry: one failure note per failed week.
        notifyFailure: attempt?.notifyFailure,
      }),
    runStatus: async (weekId) => (await deps.store.getRunRecord(weekId))?.status,
    clock: deps.clock,
    logger: deps.logger,
    failedRetry: DEFAULT_FAILED_RETRY,
    // The note an attempt held back goes out here if its retry never runs.
    onGiveUp: (weekId, lastResult) => sendHeldNote(deps, weekId, lastResult.record),
  });
  const nextRun = scheduler.nextRun();
  if (nextRun === null) {
    deps.logger.warn('The schedule has no upcoming run: check schedule.cron', { cron, timeZone });
  }
  deps.logger.info('Scheduler started', {
    cron,
    timeZone,
    nextRun: nextRun?.toISOString() ?? null,
  });

  const signal = await signalled;
  deps.logger.info('Scheduler stopping', { signal });
  scheduler.stop();
  // Closing the app under a running digest would cut its traces and store, so wait for it.
  await untilIdle(io, scheduler, deps.logger, (reason) => {
    quitNow.abort(reason);
  });
}

/**
 * Waits for the run in flight. A second signal asks it to stop: collect and the guards stop
 * within one call, other steps finish first; a third ends the process the usual way, as nothing
 * listens.
 */
async function untilIdle(
  io: ServeCommandIo,
  scheduler: SchedulerHandle,
  logger: Logger,
  abortRun: (reason: Error) => void,
): Promise<void> {
  const idle = scheduler.whenIdle();
  const stopListening = new AbortController();
  const again = io.waitForSignal(stopListening.signal);
  try {
    const second = await Promise.race([idle.then(() => undefined), again]);
    if (second === undefined) return;
    logger.warn('Second signal: the running digest stops after its current step', {
      signal: second,
    });
    abortRun(new Error(`the service was asked to stop again (${second})`));
    await idle;
  } finally {
    stopListening.abort();
  }
}

/** A failing close is logged, not thrown: it must not hide how the service ended. */
async function closeApp(app: AppHandle): Promise<void> {
  try {
    await app.close();
  } catch (error) {
    app.deps.logger.error('Failed to close the app', { error: errorMessage(error) });
  }
}

/**
 * Resolves on the first SIGINT or SIGTERM, then stops listening, so a later signal ends the
 * process the usual way unless something listens again. Firing `cancel` stops the listening too.
 */
export function waitForShutdownSignal(cancel?: AbortSignal): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    if (cancel?.aborted) return;
    const listeners = new Map<NodeJS.Signals, () => void>();
    const removeAll = (): void => {
      for (const [signal, listener] of listeners) process.off(signal, listener);
      cancel?.removeEventListener('abort', removeAll);
    };
    for (const signal of SHUTDOWN_SIGNALS) {
      const listener = (): void => {
        removeAll();
        resolve(signal);
      };
      listeners.set(signal, listener);
      process.on(signal, listener);
    }
    cancel?.addEventListener('abort', removeAll, { once: true });
  });
}
