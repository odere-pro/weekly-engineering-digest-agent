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
import { createLogger } from '../observability/logger.js';
import { createTracer } from '../observability/tracing.js';
import { systemClock } from '../shared/clock.js';
import { DigestError, errorMessage } from '../shared/errors.js';

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

function assemble({ config, env, secrets, profile }: LoadedConfig): AppHandle {
  const deliveries = buildDeliveries(config, secrets);
  const redactValues = secretValues(secrets);
  const logger = createLogger({ level: env.LOG_LEVEL, redactValues });
  const model = createOllamaProvider({
    baseUrl: env.OLLAMA_URL,
    profile,
    timeoutsMs: config.models.timeoutsMs,
    think: config.models.think,
    retries: config.models.retries,
    logger,
  });
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
      rss: createRssFetcher(),
      github: createGithubReleasesFetcher({ token: secrets.GITHUB_TOKEN }),
    },
    inputGuards: [createClefPolicyGuard(decision), createGraniteRiskGuard({ model })],
    outputGuards: [createGraniteGroundednessGuard({ model }), createClefRubricGuard(decision)],
    deliveries,
    store: createFsRunStore({ dataDir: config.dataDir, clock: systemClock, logger }),
    logger,
    clock: systemClock,
  };
  // Last, so a failure while building anything above never leaves a tracer registered.
  const tracer = createTracer({ endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT, redactValues });

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

function secretValues(secrets: Secrets): string[] {
  return Object.values(secrets).filter(
    (value): value is string => typeof value === 'string' && value !== '',
  );
}
