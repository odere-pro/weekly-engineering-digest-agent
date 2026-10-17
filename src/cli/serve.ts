import { buildApp, type AppHandle } from '../app/container.js';
import { loadConfig, type LoadedConfig } from '../config/load.js';
import { runDigest } from '../core/runDigest.js';
import { startScheduler } from '../scheduler/scheduler.js';
import { DigestError, errorMessage } from '../shared/errors.js';

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
  /** Resolves with the signal that asks the service to stop. */
  waitForSignal: () => Promise<NodeJS.Signals>;
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
  const scheduler = await io.startScheduler({
    cron,
    timeZone,
    run: (weekId) => io.runDigest(deps, { weekId }),
    runStatus: async (weekId) => (await deps.store.getRunRecord(weekId))?.status,
    clock: deps.clock,
    logger: deps.logger,
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
  // Closing the app under a running digest would cut its traces and store; a second signal quits now.
  await scheduler.whenIdle();
}

/** A failing close is logged, not thrown: it must not hide how the service ended. */
async function closeApp(app: AppHandle): Promise<void> {
  try {
    await app.close();
  } catch (error) {
    app.deps.logger.error('Failed to close the app', { error: errorMessage(error) });
  }
}

/** Resolves on the first SIGINT or SIGTERM. A second one then ends the process the usual way. */
export function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const removeAll = (): void => {
      for (const [signal, listener] of listeners) process.off(signal, listener);
    };
    for (const signal of SHUTDOWN_SIGNALS) {
      const listener = (): void => {
        removeAll();
        resolve(signal);
      };
      listeners.set(signal, listener);
      process.on(signal, listener);
    }
  });
}
