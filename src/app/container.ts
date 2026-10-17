// Composition root: the only place that turns config into real adapters.
import { createMarkdownFileDelivery } from '../adapters/delivery/markdownFile.js';
import { createSlackDelivery } from '../adapters/delivery/slack.js';
import { createSmtpDelivery } from '../adapters/delivery/smtp.js';
import { createClefPolicyGuard, createClefRubricGuard } from '../adapters/guard/clefPolicy.js';
import {
  createGraniteGroundednessGuard,
  createGraniteRiskGuard,
} from '../adapters/guard/granite.js';
import { createOllamaProvider } from '../adapters/models/ollama.js';
import { createGithubReleasesFetcher } from '../adapters/sources/githubReleases.js';
import { createRssFetcher } from '../adapters/sources/rss.js';
import { createFsRunStore } from '../adapters/store/fsRunStore.js';
import type { LoadedConfig } from '../config/load.js';
import type { Config, Secrets } from '../config/schema.js';
import type { DigestDeps } from '../core/runDigest.js';
import type { Delivery } from '../ports/Delivery.js';
import type { ModelProvider } from '../ports/ModelProvider.js';
import { createLogger } from '../observability/logger.js';
import { createRedactor, type Redactor } from '../observability/redact.js';
import { createTracer } from '../observability/tracing.js';
import { systemClock } from '../shared/clock.js';
import { DigestError, errorMessage } from '../shared/errors.js';
import type { Logger } from '../shared/telemetry.js';
import { knownSecrets, redactDelivery, redactStore } from './redacting.js';
import { withDeliveryRetry } from './retryingDelivery.js';
import { deferTracer, traceModel } from './tracedModel.js';

export interface AppHandle {
  deps: DigestDeps;
  /** Flushes traces and closes resources. */
  close(): Promise<void>;
}

/**
 * Builds DigestDeps from the loaded config (W2-02). Rejects with a DigestError naming the
 * variable when a configured channel lacks its secret; nothing is started before that check.
 */
export function buildApp(loaded: LoadedConfig): Promise<AppHandle> {
  // A throw inside the executor rejects the promise, so callers always get a rejection.
  return new Promise((resolve) => {
    resolve(assemble(loaded));
  });
}

/**
 * The one place a model provider is built, for a run and for `digest doctor` alike. Doctor only
 * calls `health()`, which uses none of the per-role options, and passes its own `fetch`.
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
    logger: extras.logger,
    fetch: extras.fetch,
  });
}

function assemble(loaded: LoadedConfig): AppHandle {
  const { config, env, secrets, profile } = loaded;
  const channels = buildDeliveries(config, secrets);
  const redactValues = knownSecrets(secrets);
  const redactor = createRedactor(redactValues);
  const logger = createLogger({ level: env.LOG_LEVEL, redactValues });
  const tracing = deferTracer();
  const model = traceModel(createModelProvider(loaded, { logger }), tracing.tracer);
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
      rss: createRssFetcher({ logger }),
      github: createGithubReleasesFetcher({ token: secrets.GITHUB_TOKEN }),
    },
    inputGuards: [createClefPolicyGuard(decision), createGraniteRiskGuard({ model })],
    outputGuards: [createGraniteGroundednessGuard({ model }), createClefRubricGuard(decision)],
    deliveries: guardChannels(channels, logger, redactor),
    store: redactStore(
      createFsRunStore({ dataDir: config.dataDir, clock: systemClock, logger }),
      redactor,
    ),
    logger,
    clock: systemClock,
  };
  // Last, so a failure while building anything above never leaves a tracer registered. The model
  // and the guards were built before it: their spans reach it through the deferred tracer.
  const tracer = createTracer({ endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT, redactValues });
  tracing.bind(tracer);

  return {
    deps: { ...parts, tracer },
    close: async () => {
      try {
        await tracer.shutdown();
      } catch (error) {
        // A telemetry outage must not turn a finished run into a failure.
        logger.warn(`tracer shutdown failed: ${errorMessage(error)}`);
      }
    },
  };
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
  const { markdown, email, slack } = config.delivery;
  const deliveries: Delivery[] = [createMarkdownFileDelivery({ dir: markdown.dir })];
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
