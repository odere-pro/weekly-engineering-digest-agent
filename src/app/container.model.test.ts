import { describe, expect, it, vi } from 'vitest';
import { createGraniteRiskGuard } from '../guards/adapters/granite';
import { createOllamaProvider } from '../models/adapters/ollama';
import { createRssFetcher } from '../sources/adapters/rss';
import { buildApp, createModelProvider } from './container';
import type { LoadedConfig } from '../config/load';
import { resolveProfile, type Platform } from '../config/profiles';
import {
  EnvSchema,
  SecretsSchema,
  type ConfigInput,
  type Env,
  type Secrets,
} from '../config/schema';
import { createTracer, type TracingHandle } from '../observability/tracing';
import { noopLogger, type Tracer } from '../shared/telemetry';
import { makeConfig } from '../../test/builders';
import { FakeModelProvider } from '../../test/fakes';

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

vi.mock('../models/adapters/ollama', (load) => wrapFactories(load, ['createOllamaProvider']));
vi.mock('../sources/adapters/rss', (load) => wrapFactories(load, ['createRssFetcher']));
vi.mock('../guards/adapters/granite', (load) =>
  wrapFactories(load, ['createGraniteRiskGuard', 'createGraniteGroundednessGuard']),
);
vi.mock('../observability/tracing', (load) => wrapFactories(load, ['createTracer']));

// Any logger: the one the model and the fetchers get is run-aware (container.runLogging.test.ts).
const ANY_FUNCTION: unknown = expect.any(Function);
const ANY_LOGGER: unknown = expect.objectContaining({ warn: ANY_FUNCTION, child: ANY_FUNCTION });
/** The archive's tap on the raw answers (`sources/adapters/archive`). */
const ANY_TAP: unknown = expect.objectContaining({ answer: ANY_FUNCTION });

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

describe('buildApp model', () => {
  const request = { role: 'write', system: 'sys', prompt: 'prompt' } as const;

  it('answers every model call with the Ollama provider', async () => {
    const provider = new FakeModelProvider({ generate: () => 'draft' });
    vi.mocked(createOllamaProvider).mockReturnValueOnce(provider);
    const { deps } = await buildApp(loadedConfig());

    const result = await deps.model.generate(request);

    expect(result.text).toBe('draft');
    expect(provider.generateCalls).toEqual([request]);
  });

  it('opens a span for each model call on the tracer that is created last', async () => {
    const { tracer, spans } = recordingTracer();
    vi.mocked(createTracer).mockReturnValueOnce(tracer);
    vi.mocked(createOllamaProvider).mockReturnValueOnce(
      new FakeModelProvider({ generate: () => 'draft' }),
    );
    const { deps } = await buildApp(loadedConfig());

    await deps.model.generate(request);

    expect(spans.map((span) => span.name)).toEqual(['model.generate', 'model.usage']);
    expect(JSON.stringify(spans)).not.toContain('prompt');
  });

  it('gives the guards the traced model', async () => {
    const { tracer, spans } = recordingTracer();
    vi.mocked(createTracer).mockReturnValueOnce(tracer);
    vi.mocked(createOllamaProvider).mockReturnValueOnce(
      new FakeModelProvider({ generate: () => 'draft' }),
    );
    await buildApp(loadedConfig());

    const guardModel = firstCallOptions(createGraniteRiskGuard).model;
    await guardModel.generate({ role: 'guardRisk', system: 's', prompt: 'p' });

    expect(spans.map((span) => span.name)).toContain('model.generate');
  });

  it('works without a tracer endpoint, where spans do nothing', async () => {
    vi.mocked(createOllamaProvider).mockReturnValueOnce(
      new FakeModelProvider({ generate: () => 'draft' }),
    );
    const { deps } = await buildApp(loadedConfig());

    await expect(deps.model.generate(request)).resolves.toMatchObject({ text: 'draft' });
  });

  it('reports the health of the provider untouched', async () => {
    vi.mocked(createOllamaProvider).mockReturnValueOnce(
      new FakeModelProvider({ health: { reachable: false, models: [], error: 'down' } }),
    );
    const { deps } = await buildApp(loadedConfig());

    await expect(deps.model.health()).resolves.toMatchObject({ reachable: false, error: 'down' });
  });
});

describe('buildApp fetchers', () => {
  it('gives the RSS fetcher a logger, so its per-feed warnings reach the log', async () => {
    await buildApp(loadedConfig());

    // Run-aware, like the model's: container.runLogging.test.ts shows the run id on its lines.
    expect(firstCallOptions(createRssFetcher)).toEqual({ logger: ANY_LOGGER, tap: ANY_TAP });
  });
});

describe('createModelProvider', () => {
  it('builds the Ollama provider from the loaded config, the logger and the fetch given', () => {
    const loaded = loadedConfig({
      config: { models: { timeoutsMs: { write: 900_000 }, retries: 4, think: { write: 'low' } } },
      env: { OLLAMA_URL: 'http://ollama.internal:11434' },
    });
    const fetchImpl = vi.fn<typeof fetch>();

    createModelProvider(loaded, { logger: noopLogger, fetch: fetchImpl });

    expect(firstCallOptions(createOllamaProvider)).toEqual({
      baseUrl: 'http://ollama.internal:11434',
      profile: loaded.profile,
      timeoutsMs: { write: 900_000 },
      think: { write: 'low' },
      retries: 4,
      seed: 42,
      temperature: undefined,
      logger: noopLogger,
      fetch: fetchImpl,
    });
  });

  it('leaves fetch to the adapter when none is given', () => {
    createModelProvider(loadedConfig(), { logger: noopLogger });

    expect(firstCallOptions(createOllamaProvider).fetch).toBeUndefined();
  });

  it('returns the provider the factory built', () => {
    const provider = new FakeModelProvider();
    vi.mocked(createOllamaProvider).mockReturnValueOnce(provider);

    expect(createModelProvider(loadedConfig(), { logger: noopLogger })).toBe(provider);
  });
});
