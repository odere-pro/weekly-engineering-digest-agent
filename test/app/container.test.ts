import { describe, expect, it, vi } from 'vitest';
import {
  createClefPolicyGuard,
  createClefRubricGuard,
} from '../../src/adapters/guard/clefPolicy.js';
import {
  createGraniteGroundednessGuard,
  createGraniteRiskGuard,
} from '../../src/adapters/guard/granite.js';
import { createMarkdownFileDelivery } from '../../src/adapters/delivery/markdownFile.js';
import { createSlackDelivery } from '../../src/adapters/delivery/slack.js';
import { createSmtpDelivery } from '../../src/adapters/delivery/smtp.js';
import { createOllamaProvider } from '../../src/adapters/models/ollama.js';
import { createGithubReleasesFetcher } from '../../src/adapters/sources/githubReleases.js';
import { createFsRunStore } from '../../src/adapters/store/fsRunStore.js';
import { buildApp } from '../../src/app/container.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { resolveProfile, type Platform } from '../../src/config/profiles.js';
import {
  EnvSchema,
  SecretsSchema,
  type ConfigInput,
  type Env,
  type Secrets,
} from '../../src/config/schema.js';
import { createLogger } from '../../src/observability/logger.js';
import { createTracer, type TracingHandle } from '../../src/observability/tracing.js';
import type { Tracer } from '../../src/shared/telemetry.js';
import { DigestError } from '../../src/shared/errors.js';
import { systemClock } from '../../src/shared/clock.js';
import { makeConfig } from '../builders.js';

// Each factory below still builds the real adapter; the spy only records how it was called.
const wrapFactories = vi.hoisted(
  () =>
    async (
      load: () => Promise<Record<string, unknown>>,
      names: readonly string[],
    ): Promise<Record<string, unknown>> => {
      const actual = await load();
      const spies: [string, unknown][] = names.map((name) => [
        name,
        vi.fn(actual[name] as (...args: never[]) => unknown),
      ]);
      return { ...actual, ...(Object.fromEntries(spies) as Record<string, unknown>) };
    },
);

vi.mock('../../src/adapters/models/ollama.js', (load) =>
  wrapFactories(load, ['createOllamaProvider']),
);
vi.mock('../../src/adapters/store/fsRunStore.js', (load) =>
  wrapFactories(load, ['createFsRunStore']),
);
vi.mock('../../src/adapters/delivery/markdownFile.js', (load) =>
  wrapFactories(load, ['createMarkdownFileDelivery']),
);
vi.mock('../../src/adapters/delivery/smtp.js', (load) =>
  wrapFactories(load, ['createSmtpDelivery']),
);
vi.mock('../../src/adapters/delivery/slack.js', (load) =>
  wrapFactories(load, ['createSlackDelivery']),
);
vi.mock('../../src/adapters/sources/githubReleases.js', (load) =>
  wrapFactories(load, ['createGithubReleasesFetcher']),
);
vi.mock('../../src/adapters/guard/clefPolicy.js', (load) =>
  wrapFactories(load, ['createClefPolicyGuard', 'createClefRubricGuard']),
);
vi.mock('../../src/adapters/guard/granite.js', (load) =>
  wrapFactories(load, ['createGraniteRiskGuard', 'createGraniteGroundednessGuard']),
);
vi.mock('../../src/observability/logger.js', (load) => wrapFactories(load, ['createLogger']));
vi.mock('../../src/observability/tracing.js', (load) => wrapFactories(load, ['createTracer']));

// Any logger: the one the model and the fetchers get is run-aware (container.runLogging.test.ts).
const ANY_FUNCTION: unknown = expect.any(Function);
const ANY_LOGGER: unknown = expect.objectContaining({ warn: ANY_FUNCTION, child: ANY_FUNCTION });

const SMTP_PASSWORD = 'smtp-password-4f9a';
const SLACK_WEBHOOK_PATH = '/services/T000/B000/slack-secret-7c1e';
const SLACK_WEBHOOK_URL = `https://hooks.slack.test${SLACK_WEBHOOK_PATH}`;
const GITHUB_TOKEN = 'ghp_github-token-82bd';
const ALL_SECRETS: Secrets = {
  SMTP_PASSWORD,
  SLACK_WEBHOOK_URL,
  GITHUB_TOKEN,
};

const EMAIL = {
  host: 'smtp.example.test',
  port: 465,
  secure: true,
  user: 'digest@example.test',
  from: 'digest@example.test',
  to: ['me@example.test', 'team@example.test'],
};

interface LoadedOptions {
  config?: Partial<ConfigInput>;
  secrets?: Secrets;
  env?: Record<string, string>;
}

function loadedConfig(options: LoadedOptions = {}): LoadedConfig {
  const config = makeConfig(options.config);
  const env: Env = EnvSchema.parse(options.env ?? {});
  const secrets = SecretsSchema.parse(options.secrets ?? {});
  const platform: Platform = { os: 'darwin', arch: 'arm64' };
  const profile = resolveProfile(config.profile, platform, config.models.writers);
  return { config, env, secrets, profile, platform, configPath: '/project/digest.config.json' };
}

function firstCallOptions<Args extends unknown[]>(factory: (...args: Args) => unknown): Args[0] {
  const call = vi.mocked(factory).mock.calls[0];
  if (!call) throw new Error('factory was not called');
  return call[0];
}

function calledWith(factory: (...args: never[]) => unknown): number {
  return vi.mocked(factory).mock.calls.length;
}

function fakeTracer(shutdown: () => Promise<void> = () => Promise.resolve()): {
  tracer: TracingHandle;
  shutdownSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  const shutdownSpy = vi.fn(shutdown);
  return { tracer: { span: (_name, _attributes, fn) => fn(), shutdown: shutdownSpy }, shutdownSpy };
}

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
}

function recordingTracer(): { tracer: TracingHandle; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const traced: Tracer = {
    span: (name, attributes, fn) => {
      spans.push({ name, attributes });
      return fn();
    },
  };
  return { tracer: { ...traced, shutdown: () => Promise.resolve() }, spans };
}

describe('buildApp wiring', () => {
  it('wires Markdown delivery alone when nothing else is configured', async () => {
    const loaded = loadedConfig({ config: { delivery: { markdown: { dir: 'out/digests' } } } });

    const app = await buildApp(loaded);

    expect(app.deps.deliveries.map((delivery) => delivery.id)).toEqual(['markdown']);
    expect(firstCallOptions(createMarkdownFileDelivery)).toEqual({ dir: 'out/digests' });
    expect(calledWith(createSmtpDelivery)).toBe(0);
    expect(calledWith(createSlackDelivery)).toBe(0);
  });

  it('hands the loaded config and profile to the core unchanged', async () => {
    const loaded = loadedConfig();

    const { deps } = await buildApp(loaded);

    expect(deps.config).toBe(loaded.config);
    expect(deps.profile).toBe(loaded.profile);
    expect(deps.clock).toBe(systemClock);
  });

  it('adds email delivery when it is configured, with TLS required by default', async () => {
    const loaded = loadedConfig({
      config: { delivery: { email: EMAIL } },
      secrets: { SMTP_PASSWORD },
    });

    const app = await buildApp(loaded);

    expect(app.deps.deliveries.map((delivery) => delivery.id)).toEqual(['markdown', 'email']);
    expect(firstCallOptions(createSmtpDelivery)).toEqual({
      host: EMAIL.host,
      port: EMAIL.port,
      secure: EMAIL.secure,
      requireTLS: true,
      user: EMAIL.user,
      password: SMTP_PASSWORD,
      from: EMAIL.from,
      to: EMAIL.to,
    });
  });

  it('passes requireTLS: false through for a local mail catcher', async () => {
    const loaded = loadedConfig({
      config: { delivery: { email: { ...EMAIL, requireTLS: false } } },
      secrets: { SMTP_PASSWORD },
    });

    await buildApp(loaded);

    expect(firstCallOptions(createSmtpDelivery)).toMatchObject({ requireTLS: false });
  });

  it('adds Slack delivery when it is enabled', async () => {
    const loaded = loadedConfig({
      config: { delivery: { slack: { enabled: true } } },
      secrets: { SLACK_WEBHOOK_URL },
    });

    const app = await buildApp(loaded);

    expect(app.deps.deliveries.map((delivery) => delivery.id)).toEqual(['markdown', 'slack']);
    expect(firstCallOptions(createSlackDelivery)).toEqual({ webhookUrl: SLACK_WEBHOOK_URL });
  });

  it('ignores a Slack section that is switched off, even with a webhook in .env', async () => {
    const loaded = loadedConfig({
      config: { delivery: { slack: { enabled: false } } },
      secrets: { SLACK_WEBHOOK_URL },
    });

    const app = await buildApp(loaded);

    expect(app.deps.deliveries.map((delivery) => delivery.id)).toEqual(['markdown']);
    expect(calledWith(createSlackDelivery)).toBe(0);
  });

  it('wires every channel in a fixed order: Markdown, email, Slack', async () => {
    const loaded = loadedConfig({
      config: { delivery: { email: EMAIL, slack: { enabled: true } } },
      secrets: ALL_SECRETS,
    });

    const app = await buildApp(loaded);

    expect(app.deps.deliveries.map((delivery) => delivery.id)).toEqual([
      'markdown',
      'email',
      'slack',
    ]);
  });

  it('builds the Ollama provider from the env URL, the profile and the model overrides', async () => {
    const loaded = loadedConfig({
      config: { models: { timeoutsMs: { write: 900_000 }, retries: 4 } },
      env: { OLLAMA_URL: 'http://ollama.internal:11434' },
    });

    await buildApp(loaded);

    // The logger is the run-aware one (container.runLogging.test.ts), not the app logger.
    expect(firstCallOptions(createOllamaProvider)).toEqual({
      baseUrl: 'http://ollama.internal:11434',
      profile: loaded.profile,
      timeoutsMs: { write: 900_000 },
      retries: 4,
      logger: ANY_LOGGER,
    });
  });

  it('passes models.think to the Ollama provider', async () => {
    const think = { write: 'low', guardRisk: true, classify: false } as const;
    const loaded = loadedConfig({ config: { models: { think } } });

    await buildApp(loaded);

    expect(firstCallOptions(createOllamaProvider).think).toEqual(think);
  });

  it('leaves think undefined when the config has none, so the adapter defaults apply', async () => {
    await buildApp(loadedConfig());

    expect(firstCallOptions(createOllamaProvider).think).toBeUndefined();
  });

  it('wires one fetcher per source kind', async () => {
    const { deps } = await buildApp(loadedConfig());

    expect(deps.fetchers.rss?.kind).toBe('rss');
    expect(deps.fetchers.github?.kind).toBe('github');
    expect(Object.keys(deps.fetchers).sort()).toEqual(['github', 'rss']);
  });

  it('gives the GitHub fetcher the token, and no token when none is set', async () => {
    await buildApp(loadedConfig({ secrets: { GITHUB_TOKEN } }));
    expect(firstCallOptions(createGithubReleasesFetcher)).toEqual({
      token: GITHUB_TOKEN,
      logger: ANY_LOGGER,
    });

    vi.mocked(createGithubReleasesFetcher).mockClear();
    await buildApp(loadedConfig());
    expect(firstCallOptions(createGithubReleasesFetcher)).toEqual({
      token: undefined,
      logger: ANY_LOGGER,
    });
  });

  it('orders the input guards policy then risk, and the output guards groundedness then rubric', async () => {
    const { deps } = await buildApp(loadedConfig());

    expect(deps.inputGuards.map((guard) => guard.id)).toEqual(['clefPolicy', 'graniteRisk']);
    expect(deps.outputGuards.map((guard) => guard.id)).toEqual([
      'graniteGroundedness',
      'clefRubric',
    ]);
  });

  it('gives the decision guards the model, the flag threshold and the focus areas', async () => {
    const loaded = loadedConfig({
      config: { thresholds: { guardFlag: 0.7 }, focusAreas: ['Platform engineering'] },
    });

    const { deps } = await buildApp(loaded);

    const decisionOptions = {
      model: deps.model,
      flagThreshold: 0.7,
      focusAreas: ['Platform engineering'],
    };
    expect(firstCallOptions(createClefPolicyGuard)).toEqual(decisionOptions);
    expect(firstCallOptions(createClefRubricGuard)).toEqual(decisionOptions);
    expect(firstCallOptions(createGraniteRiskGuard)).toEqual({ model: deps.model });
    expect(firstCallOptions(createGraniteGroundednessGuard)).toEqual({ model: deps.model });
  });

  it('stores runs under the data dir and shares the app logger with the store', async () => {
    const { deps } = await buildApp(loadedConfig({ config: { dataDir: 'var/digest' } }));

    expect(firstCallOptions(createFsRunStore)).toEqual({
      dataDir: 'var/digest',
      clock: systemClock,
      logger: deps.logger,
    });
  });

  it('builds the logger at the env level and the tracer at the env endpoint', async () => {
    const { tracer, spans } = recordingTracer();
    vi.mocked(createTracer).mockReturnValueOnce(tracer);
    const loaded = loadedConfig({
      env: {
        LOG_LEVEL: 'debug',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/v1/traces',
      },
    });

    const { deps } = await buildApp(loaded);
    await deps.tracer.span('probe', { step: 'probe' }, () => Promise.resolve());

    expect(firstCallOptions(createLogger)).toMatchObject({ level: 'debug' });
    expect(firstCallOptions(createTracer)).toMatchObject({
      endpoint: 'http://localhost:4318/v1/traces',
    });
    // The app's tracer hands every span to the one that was built (it only adds the run scope).
    expect(spans).toEqual([{ name: 'probe', attributes: { step: 'probe' } }]);
  });

  it('creates no tracer when a later adapter fails to build', async () => {
    const valid = loadedConfig({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/v1/traces' },
    });
    const outOfRange = {
      ...valid,
      config: { ...valid.config, thresholds: { ...valid.config.thresholds, guardFlag: 1.5 } },
    };

    await expect(buildApp(outOfRange)).rejects.toBeInstanceOf(DigestError);

    expect(calledWith(createTracer)).toBe(0);
  });
});

describe('AppHandle.close', () => {
  it('shuts the tracer down', async () => {
    const { tracer, shutdownSpy } = fakeTracer();
    vi.mocked(createTracer).mockReturnValueOnce(tracer);
    const app = await buildApp(loadedConfig());

    await app.close();

    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  });

  it('warns and resolves when the final flush fails, so a sent digest stays sent', async () => {
    const { tracer } = fakeTracer(() => Promise.reject(new Error('collector unreachable')));
    vi.mocked(createTracer).mockReturnValueOnce(tracer);
    const app = await buildApp(loadedConfig());
    const warn = vi.spyOn(app.deps.logger, 'warn').mockImplementation(() => undefined);

    await expect(app.close()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('collector unreachable'));
  });
});
