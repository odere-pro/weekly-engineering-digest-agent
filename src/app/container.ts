// Composition root: the only place that turns config into real adapters.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createMarkdownFileDelivery, markdownFileOptions } from '../delivery/adapters/markdownFile';
import { createSlackDelivery } from '../delivery/adapters/slack';
import { createSmtpDelivery } from '../delivery/adapters/smtp';
import { createRuleInjectionGuard } from '../guards/adapters/ruleInjection';
import { createClefPolicyGuard, createClefRubricGuard } from '../guards/adapters/clefPolicy';
import { createGraniteGroundednessGuard, createGraniteRiskGuard } from '../guards/adapters/granite';
import { createOllamaProvider } from '../models/adapters/ollama';
import { effectiveTemperature } from '../models/adapters/chat/chatSettings';
import { createSourceArchiving } from '../sources/adapters/archive/archivingFetcher';
import { createSourceArchive } from '../sources/adapters/archive/sourceArchive';
import { createGithubReleasesFetcher } from '../sources/adapters/githubReleases';
import { createRssFetcher } from '../sources/adapters/rss';
import { createFsRunStore } from '../store/adapters/fsRunStore';
import { weekDay } from '../store/layout';
import type { LoadedConfig } from '../config/load';
import type { Config, Secrets } from '../config/schema';
import type { DigestDeps } from '../digest/types';
import { RoleSchema } from '../models/roles';
import type { Delivery } from '../delivery/Delivery';
import type { ModelProvider } from '../models/ModelProvider';
import { createLogger } from '../observability/logger';
import { createRedactor, type Redactor } from '../observability/redact';
import { createTracer } from '../observability/tracing';
import { systemClock } from '../shared/clock';
import { DigestError, errorMessage } from '../shared/errors';
import type { LogFields, Logger, Tracer } from '../shared/telemetry';
import { withAnswerCache } from './answerCache/withAnswerCache';
import { redactDelivery, redactStore } from './redacting';
import { knownSecrets } from './redaction/knownSecrets';
import { withDeliveryRetry } from './retryingDelivery';
import { deferTracer, traceModel } from './tracedModel';

export interface AppHandle {
  deps: DigestDeps;
  /** Flushes traces and closes resources. */
  close(): Promise<void>;
}

export interface AppOptions {
  /** Reuse a week's saved model answers (`answerCache/`); default true. The eval turns it off. */
  reuseAnswers?: boolean;
}

/**
 * Builds DigestDeps from the loaded config (W2-02). Rejects with a DigestError naming the
 * variable when a configured channel lacks its secret; nothing is started before that check.
 */
export function buildApp(loaded: LoadedConfig, options: AppOptions = {}): Promise<AppHandle> {
  // A throw inside the executor rejects the promise, so callers always get a rejection.
  return new Promise((resolve) => {
    resolve(assemble(loaded, options));
  });
}

/**
 * The one place a model provider is built from a loaded config: for a run, for `digest eval` and
 * for `digest doctor`. Doctor only calls `health()`, which uses none of the per-role options, and
 * passes its own `fetch`. `digest doctor --readiness` runs without a usable config, so it builds
 * its provider itself (`cli/doctor/readiness/target.ts`, `createOllamaProvider` with defaults).
 */
export function createModelProvider(
  { config, env, profile }: LoadedConfig,
  extras: { logger: Logger; fetch?: typeof fetch },
): ModelProvider {
  return createOllamaProvider({
    baseUrl: env.OLLAMA_URL,
    profile,
    timeoutsMs: config.models.timeoutsMs,
    think: config.models.think,
    retries: config.models.retries,
    seed: config.models.seed,
    temperature: config.models.temperature,
    logger: extras.logger,
    fetch: extras.fetch,
  });
}

/**
 * The logger of a run and of `digest eval`: JSON lines at `LOG_LEVEL` on stdout and in the day's
 * log file (`<dataDir>/logs/<day>/digest.log`), with every known secret taken out.
 */
export function createAppLogger({
  config,
  env,
  secrets,
}: Pick<LoadedConfig, 'config' | 'env' | 'secrets'>): Logger {
  return createLogger({
    level: env.LOG_LEVEL,
    redactValues: knownSecrets(secrets, env.OLLAMA_URL),
    file: { dataDir: config.dataDir, timeZone: config.schedule.timeZone },
  });
}

/** The seed and the temperature each role's calls send, as the run record keeps them. */
function samplingOf(
  models: Pick<Config['models'], 'seed' | 'temperature'>,
): NonNullable<DigestDeps['sampling']> {
  const temperatureByRole = Object.fromEntries(
    RoleSchema.options.map((role) => [role, effectiveTemperature(models.temperature, role)]),
  );
  return { seed: models.seed, temperatureByRole };
}

function assemble(loaded: LoadedConfig, options: AppOptions): AppHandle {
  const { config, env, secrets, profile } = loaded;
  const channels = buildDeliveries(config, secrets);
  const redactValues = knownSecrets(secrets, env.OLLAMA_URL);
  const redactor = createRedactor(redactValues);
  const logger = createAppLogger(loaded);
  // The model and the fetchers are built once, but a `serve` process runs many weeks: what they
  // log belongs to the run in flight, so they get a logger that looks the run up on every line.
  const runs = new AsyncLocalStorage<RunScope>();
  const runLogger = perRunLogger(logger, runs);
  // A run saves what each source answered and returned in its week's day folder (`store/layout`).
  const archiving = createSourceArchiving({
    archive: createSourceArchive({
      dataDir: config.dataDir,
      redact: (text) => redactor.text(text),
    }),
    day: () => {
      const runId = runs.getStore()?.runId;
      return runId === undefined ? undefined : weekDay(runId);
    },
    logger: runLogger,
  });
  const tracing = deferTracer();
  const model = traceModel(
    withAnswerCache(createModelProvider(loaded, { logger: runLogger }), loaded, {
      enabled: options.reuseAnswers !== false,
      week: () => runs.getStore()?.runId,
      redactor,
      logger: runLogger,
    }),
    tracing.tracer,
  );
  const decision = {
    model,
    flagThreshold: config.thresholds.guardFlag,
    focusAreas: config.focusAreas,
  };
  const parts: Omit<DigestDeps, 'tracer'> = {
    config,
    profile,
    model,
    fetchers: {
      rss: archiving.wrap(createRssFetcher({ logger: runLogger, tap: archiving.tap })),
      github: archiving.wrap(
        createGithubReleasesFetcher({
          token: secrets.GITHUB_TOKEN,
          logger: runLogger,
          tap: archiving.tap,
        }),
      ),
    },
    inputGuards: [
      createRuleInjectionGuard({ allowedHosts: feedHosts(config.sources) }),
      createClefPolicyGuard(decision),
      createGraniteRiskGuard({ model }),
    ],
    outputGuards: [createGraniteGroundednessGuard({ model }), createClefRubricGuard(decision)],
    deliveries: guardChannels(channels, logger, redactor),
    store: redactStore(
      createFsRunStore({ dataDir: config.dataDir, clock: systemClock, logger }),
      redactor,
    ),
    logger,
    clock: systemClock,
    sampling: samplingOf(config.models),
  };
  // Last, so a failure while building anything above never leaves a tracer registered. The model
  // and the guards were built before it: their spans reach it through the deferred tracer.
  const tracer = createTracer({ endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT, redactValues });
  tracing.bind(tracer);

  return {
    deps: { ...parts, tracer: scopeRuns(tracer, logger, runs) },
    close: async () => {
      // The fetched data of the last run is saved in the background: wait for it (never rejects).
      await archiving.flush();
      try {
        await tracer.shutdown();
      } catch (error) {
        // A telemetry outage must not turn a finished run into a failure.
        logger.warn(`tracer shutdown failed: ${errorMessage(error)}`);
      }
    },
  };
}

/** Hosts of the configured feeds: a link to one of them is not "off-host" for the rule guard. */
function feedHosts(sources: Config['sources']): string[] {
  return sources.flatMap((source) =>
    URL.canParse(source.url) ? [new URL(source.url).hostname] : [],
  );
}

/** Each channel retries a transient failure, and sends only text with the secrets taken out. */
function guardChannels(
  channels: readonly Delivery[],
  logger: Logger,
  redactor: Redactor,
): Delivery[] {
  // Redact outside the retry, so a retried send carries the same redacted message.
  return channels.map((channel) =>
    redactDelivery(withDeliveryRetry(channel, { logger }), redactor),
  );
}

/** Markdown always, then email and Slack when configured. Recipients come from config only. */
function buildDeliveries(config: Config, secrets: Secrets): Delivery[] {
  const { email, slack } = config.delivery;
  const deliveries: Delivery[] = [createMarkdownFileDelivery(markdownFileOptions(config))];
  if (email) {
    deliveries.push(
      createSmtpDelivery({
        host: email.host,
        port: email.port,
        secure: email.secure,
        requireTLS: email.requireTLS,
        user: email.user,
        password: requireSecret(secrets.SMTP_PASSWORD, 'SMTP_PASSWORD', 'email delivery'),
        from: email.from,
        to: email.to,
      }),
    );
  }
  if (slack?.enabled) {
    deliveries.push(
      createSlackDelivery({
        webhookUrl: requireSecret(secrets.SLACK_WEBHOOK_URL, 'SLACK_WEBHOOK_URL', 'Slack delivery'),
      }),
    );
  }
  return deliveries;
}

/** Names the variable in the error, never its value. */
function requireSecret(value: string | undefined, name: string, needer: string): string {
  if (value !== undefined && value !== '') return value;
  throw new DigestError(`${needer} is configured but ${name} is not set. Add ${name} to .env.`);
}

/** The run in flight on an async call chain: its logger and its week id. */
interface RunScope {
  logger: Logger;
  runId: string;
}

/**
 * A logger for what is built once and used by every run (F45, D8). Each line goes to the logger
 * of the run in flight on this async call chain, so it carries that run's `runId` and the `step`
 * it is in, and to the root logger outside a run. Nothing is kept between runs: the run is looked up, never stored.
 * A callback the event loop starts outside the run (an abort listener) sees no run.
 */
function perRunLogger(
  root: Logger,
  runs: AsyncLocalStorage<RunScope>,
  bindings: LogFields = {},
): Logger {
  const current = (): Logger => {
    const target = runs.getStore()?.logger ?? root;
    return Object.keys(bindings).length === 0 ? target : target.child(bindings);
  };
  return {
    debug: (message, fields) => {
      current().debug(message, fields);
    },
    info: (message, fields) => {
      current().info(message, fields);
    },
    warn: (message, fields) => {
      current().warn(message, fields);
    },
    error: (message, fields) => {
      current().error(message, fields);
    },
    child: (fields) => perRunLogger(root, runs, { ...bindings, ...fields }),
  };
}

/**
 * Core opens its `runDigest` span with the run's id as the `runId` attribute, and the span of
 * every step with the `runId` and the `step`. Whatever runs inside such a span is in that run, and
 * in that step: the logger above finds the logger for both there, and two runs in one process
 * never see each other's.
 */
function scopeRuns(tracer: Tracer, root: Logger, runs: AsyncLocalStorage<RunScope>): Tracer {
  return {
    span: (name, attributes, fn) => {
      const { runId, step } = attributes;
      if (typeof runId !== 'string') return tracer.span(name, attributes, fn);
      const fields = typeof step === 'string' ? { runId, step } : { runId };
      return runs.run({ logger: root.child(fields), runId }, () =>
        tracer.span(name, attributes, fn),
      );
    },
  };
}
