import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOllamaProvider } from '../../src/adapters/models/ollama.js';
import { createGithubReleasesFetcher } from '../../src/adapters/sources/githubReleases.js';
import { createRssFetcher } from '../../src/adapters/sources/rss.js';
import { buildApp } from '../../src/app/container.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { modelsInUse, resolveProfile } from '../../src/config/profiles.js';
import { EnvSchema, SecretsSchema, type ConfigInput } from '../../src/config/schema.js';
import { runDigest } from '../../src/core/runDigest.js';
import { createTracer, type TracingHandle } from '../../src/observability/tracing.js';
import type {
  DecisionAnswer,
  DecisionQuestion,
  GenerateRequest,
  ModelProvider,
} from '../../src/ports/ModelProvider.js';
import type { SourceFetcher } from '../../src/ports/SourceFetcher.js';
import type { LogFields, Logger, Tracer } from '../../src/shared/telemetry.js';
import { makeConfig, makeItem } from '../builders.js';
import { FakeSourceFetcher, MemoryRunStore } from '../fakes/index.js';

// Each factory still builds the real thing unless a test replaces it; the spy records the options.
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
vi.mock('../../src/adapters/sources/rss.js', (load) => wrapFactories(load, ['createRssFetcher']));
vi.mock('../../src/adapters/sources/githubReleases.js', (load) =>
  wrapFactories(load, ['createGithubReleasesFetcher']),
);
vi.mock('../../src/observability/tracing.js', (load) => wrapFactories(load, ['createTracer']));

const SMTP_PASSWORD = 'smtp-password-4f9a';
const GITHUB_TOKEN = 'ghp_github-token-82bd';
const WEEK_A = '2026-W43';
const WEEK_B = '2026-W44';
const MODEL_CALL = 'model call';
const HEALTH_CALL = 'health probe';
const FETCHER_WARNING = 'Skipped feed entries that could not be read';
const REQUEST: GenerateRequest = { role: 'write', system: 'sys', prompt: 'prompt' };
const ANY_FUNCTION: unknown = expect.any(Function);
const ANY_LOGGER: unknown = expect.objectContaining({ warn: ANY_FUNCTION, child: ANY_FUNCTION });
const nothing = (): Promise<void> => Promise.resolve();

function loadedConfig(
  config?: Partial<ConfigInput>,
  env: Record<string, string> = {},
): LoadedConfig {
  const built = makeConfig(config);
  return {
    config: built,
    env: EnvSchema.parse(env),
    secrets: SecretsSchema.parse({ SMTP_PASSWORD, GITHUB_TOKEN }),
    profile: resolveProfile(built.profile, { os: 'darwin', arch: 'arm64' }, built.models.writers),
    configPath: '/project/digest.config.json',
  };
}

/** One line of the JSON the built logger writes to stdout. */
interface LogLine {
  msg: string;
  level: string;
  runId?: string;
  role?: string;
  model?: string;
  [field: string]: unknown;
}

let written: string[];

beforeEach(async () => {
  written = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  // A test that wants a fake provider asks for it; the default is the real adapter.
  vi.clearAllMocks();
  const actual = await vi.importActual<{ createOllamaProvider: typeof createOllamaProvider }>(
    '../../src/adapters/models/ollama.js',
  );
  vi.mocked(createOllamaProvider).mockImplementation(actual.createOllamaProvider);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The JSON lines written so far; anything else on stdout is not a log line and is skipped. */
function logLines(message?: string): LogLine[] {
  const lines = written
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as LogLine);
  return message === undefined ? lines : lines.filter((line) => line.msg === message);
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Any valid answer: the run only has to get as far as asking the model. */
function answerTo(question: DecisionQuestion): DecisionAnswer {
  if (question.type === 'yesno') return { type: 'yesno', probability: 0.1 };
  if (question.type === 'score') {
    const levels = Object.fromEntries(
      question.levels.map((level, index) => [level, index === 0 ? 1 : 0]),
    );
    return { type: 'score', level: 0, score: 0, probabilities: levels, confidence: 1 };
  }
  const [choice = ''] = Object.keys(question.options);
  return { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 1 };
}

/**
 * A provider that logs through the logger it was built with, one line per call after a turn of the
 * event loop, the way the Ollama adapter logs a call when its attempts finish.
 */
function providerLoggingThrough(logger: Logger, models: readonly string[] = []): ModelProvider {
  return {
    generate: async (request) => {
      await nextTurn();
      logger.child({ role: request.role, model: 'fake-model' }).info(MODEL_CALL);
      return {
        model: 'fake-model',
        text: 'draft',
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
      };
    },
    decide: async (request) => {
      await nextTurn();
      logger.child({ role: request.role, model: 'fake-model' }).info(MODEL_CALL, { op: 'decide' });
      return {
        model: 'fake-model',
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [id, answerTo(question)]),
        ),
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
      };
    },
    health: () => {
      logger.info(HEALTH_CALL);
      return Promise.resolve({
        reachable: true,
        models: models.map((name) => ({ name, capabilities: [] })),
      });
    },
  };
}

function useLoggingProvider(models: readonly string[] = []): void {
  vi.mocked(createOllamaProvider).mockImplementation((options) =>
    providerLoggingThrough(options.logger, models),
  );
}

function lastCallOptions<Args extends unknown[]>(factory: (...args: Args) => unknown): Args[0] {
  const call = vi.mocked(factory).mock.calls.at(-1);
  if (!call) throw new Error('factory was not called');
  return call[0];
}

/** The logger a fetcher factory was last given. */
function loggerGivenTo(factory: (options?: { logger?: Logger }) => unknown): Logger {
  const logger = vi.mocked(factory).mock.calls.at(-1)?.[0]?.logger;
  if (!logger) throw new Error('the fetcher was built without a logger');
  return logger;
}

/** What `runDigest` does around a run: a span named for the run with its id. */
function inRun<T>(
  tracer: Tracer,
  runId: string,
  fn: () => Promise<T>,
  attributes: LogFields = {},
): Promise<T> {
  return tracer.span('runDigest', { runId, dryRun: false, ...attributes }, fn);
}

describe('model-call logs and the run', () => {
  it('logs a model call made during a run with that run id', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await inRun(deps.tracer, WEEK_A, () => deps.model.generate(REQUEST));

    expect(logLines(MODEL_CALL)).toEqual([
      expect.objectContaining({ runId: WEEK_A, role: 'write', model: 'fake-model', level: 'info' }),
    ]);
  });

  it('logs the calls of the next run with the next run id, in one process', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await inRun(deps.tracer, WEEK_A, () => deps.model.generate(REQUEST));
    await inRun(deps.tracer, WEEK_B, () => deps.model.generate(REQUEST));
    await inRun(deps.tracer, WEEK_A, () => deps.model.generate(REQUEST));

    expect(logLines(MODEL_CALL).map((line) => line.runId)).toEqual([WEEK_A, WEEK_B, WEEK_A]);
  });

  it('keeps the run ids apart when two runs overlap', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await Promise.all([
      inRun(deps.tracer, WEEK_A, () => deps.model.generate({ ...REQUEST, role: 'write' })),
      inRun(deps.tracer, WEEK_B, () => deps.model.generate({ ...REQUEST, role: 'judge' })),
    ]);

    const roleByRun = new Map(logLines(MODEL_CALL).map((line) => [line.runId, line.role]));
    expect(roleByRun).toEqual(
      new Map([
        [WEEK_A, 'write'],
        [WEEK_B, 'judge'],
      ]),
    );
  });

  it('logs a call made outside a run without a run id, also right after a run', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await deps.model.generate(REQUEST);
    await inRun(deps.tracer, WEEK_A, () => deps.model.generate(REQUEST));
    await deps.model.generate(REQUEST);

    const lines = logLines(MODEL_CALL);
    expect(lines.map((line) => line.runId)).toEqual([undefined, WEEK_A, undefined]);
    expect(lines).toHaveLength(3);
  });

  it('keeps the run id inside the spans of its steps, and for a span without one', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await inRun(deps.tracer, WEEK_A, () =>
      deps.tracer.span('write', { runId: WEEK_A, step: 'write' }, () =>
        deps.tracer.span('model.generate', { role: 'write' }, () => deps.model.generate(REQUEST)),
      ),
    );

    expect(logLines(MODEL_CALL).map((line) => line.runId)).toEqual([WEEK_A]);
  });

  it('writes the same fields as before next to the run id', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await inRun(deps.tracer, WEEK_A, () => deps.model.generate(REQUEST));

    expect(logLines(MODEL_CALL)[0]).toMatchObject({
      service: 'eng-digest',
      runId: WEEK_A,
      role: 'write',
      model: 'fake-model',
      msg: MODEL_CALL,
    });
  });

  it('still takes the known secrets out of what a run logs', async () => {
    const { deps } = await buildApp(loadedConfig());
    const { logger } = lastCallOptions(createOllamaProvider);

    await inRun(deps.tracer, WEEK_A, () => {
      logger.child({ role: 'write' }).warn(`login failed for ${SMTP_PASSWORD}`, {
        password: SMTP_PASSWORD,
      });
      return Promise.resolve();
    });

    const output = written.join('');
    expect(output).toContain('[redacted]');
    expect(output).toContain(WEEK_A);
    expect(output).not.toContain(SMTP_PASSWORD);
  });

  it('writes lines of every level with the run id', async () => {
    const { deps } = await buildApp(loadedConfig(undefined, { LOG_LEVEL: 'debug' }));
    const { logger } = lastCallOptions(createOllamaProvider);

    await inRun(deps.tracer, WEEK_A, () => {
      logger.debug('d', { a: 1 });
      logger.info('i', { b: 2 });
      logger.warn('w', { c: 3 });
      logger.error('e', { d: 4 });
      return Promise.resolve();
    });

    expect(logLines()).toEqual([
      expect.objectContaining({ level: 'debug', msg: 'd', runId: WEEK_A, a: 1 }),
      expect.objectContaining({ level: 'info', msg: 'i', runId: WEEK_A, b: 2 }),
      expect.objectContaining({ level: 'warn', msg: 'w', runId: WEEK_A, c: 3 }),
      expect.objectContaining({ level: 'error', msg: 'e', runId: WEEK_A, d: 4 }),
    ]);
  });

  it('keeps the fields of a child of a child', async () => {
    const { deps } = await buildApp(loadedConfig());
    const { logger } = lastCallOptions(createOllamaProvider);

    await inRun(deps.tracer, WEEK_A, () => {
      logger.child({ role: 'write' }).child({ model: 'm' }).info('nested', { n: 1 });
      return Promise.resolve();
    });

    expect(logLines('nested')).toEqual([
      expect.objectContaining({ runId: WEEK_A, role: 'write', model: 'm', n: 1 }),
    ]);
  });

  it('leaves the app logger as it was, without a run id', async () => {
    const { deps } = await buildApp(loadedConfig());

    await inRun(deps.tracer, WEEK_A, () => {
      deps.logger.info('scheduler line');
      return Promise.resolve();
    });

    expect(logLines('scheduler line')).toEqual([expect.not.objectContaining({ runId: WEEK_A })]);
  });
});

describe('model-call logs and the step', () => {
  /** What core does around a step: a span with the run id and the step name. */
  function inStep<T>(
    tracer: Tracer,
    runId: string,
    step: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return tracer.span(step, { runId, step }, fn);
  }

  it('logs a call made inside a step with the run id and the step', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await inRun(deps.tracer, WEEK_A, () =>
      inStep(deps.tracer, WEEK_A, 'classify', () => deps.model.generate(REQUEST)),
    );

    expect(logLines(MODEL_CALL)).toEqual([
      expect.objectContaining({ runId: WEEK_A, step: 'classify', role: 'write' }),
    ]);
  });

  it('logs a call made in a run but outside any step with the run id only', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await inRun(deps.tracer, WEEK_A, () => deps.model.generate(REQUEST));

    const [line] = logLines(MODEL_CALL);
    expect(line?.runId).toBe(WEEK_A);
    expect(line).not.toHaveProperty('step');
  });

  it('logs a call made outside any run with neither', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await deps.model.generate(REQUEST);

    const [line] = logLines(MODEL_CALL);
    expect(line).not.toHaveProperty('runId');
    expect(line).not.toHaveProperty('step');
  });

  it('tells the steps of a run apart, and drops the step when it ends', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await inRun(deps.tracer, WEEK_A, async () => {
      await inStep(deps.tracer, WEEK_A, 'collect', () => deps.model.generate(REQUEST));
      await deps.model.generate(REQUEST);
      await inStep(deps.tracer, WEEK_A, 'write', () => deps.model.generate(REQUEST));
    });
    await deps.model.generate(REQUEST);

    expect(logLines(MODEL_CALL).map((line) => [line.runId, line.step])).toEqual([
      [WEEK_A, 'collect'],
      [WEEK_A, undefined],
      [WEEK_A, 'write'],
      [undefined, undefined],
    ]);
  });

  it('keeps the step inside the spans a step opens, such as the model span', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await inRun(deps.tracer, WEEK_A, () =>
      inStep(deps.tracer, WEEK_A, 'write', () =>
        deps.tracer.span('model.generate', { role: 'write' }, () => deps.model.generate(REQUEST)),
      ),
    );

    expect(logLines(MODEL_CALL).map((line) => line.step)).toEqual(['write']);
  });

  it('keeps the steps of two overlapping runs apart', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());

    await Promise.all([
      inRun(deps.tracer, WEEK_A, () =>
        inStep(deps.tracer, WEEK_A, 'write', () =>
          deps.model.generate({ ...REQUEST, role: 'write' }),
        ),
      ),
      inRun(deps.tracer, WEEK_B, () =>
        inStep(deps.tracer, WEEK_B, 'select', () =>
          deps.model.generate({ ...REQUEST, role: 'judge' }),
        ),
      ),
    ]);

    const stepByRun = new Map(logLines(MODEL_CALL).map((line) => [line.runId, line.step]));
    expect(stepByRun).toEqual(
      new Map([
        [WEEK_A, 'write'],
        [WEEK_B, 'select'],
      ]),
    );
  });

  it('adds the step to the lines of a fetcher too', async () => {
    const { deps } = await buildApp(loadedConfig());
    const logger = loggerGivenTo(createGithubReleasesFetcher);

    await inRun(deps.tracer, WEEK_A, () =>
      inStep(deps.tracer, WEEK_A, 'collect', () => {
        logger.warn(FETCHER_WARNING, { sourceId: 'acme-widgets' });
        return Promise.resolve();
      }),
    );

    expect(logLines(FETCHER_WARNING)).toEqual([
      expect.objectContaining({ runId: WEEK_A, step: 'collect', sourceId: 'acme-widgets' }),
    ]);
  });
});

describe('fetcher warnings and the run', () => {
  it('gives the GitHub fetcher the token and a logger', async () => {
    await buildApp(loadedConfig());

    expect(lastCallOptions(createGithubReleasesFetcher)).toEqual({
      token: GITHUB_TOKEN,
      logger: ANY_LOGGER,
    });
  });

  it.each([
    ['RSS', createRssFetcher],
    ['GitHub', createGithubReleasesFetcher],
  ] as const)(
    'logs a %s fetcher warning with the run id and the source id',
    async (_kind, factory) => {
      const { deps } = await buildApp(loadedConfig());
      const logger = loggerGivenTo(factory);

      await inRun(deps.tracer, WEEK_A, () => {
        logger.warn(FETCHER_WARNING, { sourceId: 'acme-widgets', failed: 1, of: 2 });
        return Promise.resolve();
      });
      logger.warn(FETCHER_WARNING, { sourceId: 'acme-widgets', failed: 1, of: 2 });

      expect(logLines(FETCHER_WARNING)).toEqual([
        expect.objectContaining({ runId: WEEK_A, sourceId: 'acme-widgets', level: 'warn' }),
        expect.objectContaining({ sourceId: 'acme-widgets', level: 'warn' }),
      ]);
      expect(logLines(FETCHER_WARNING)[1]).not.toHaveProperty('runId');
    },
  );
});

describe('the real runDigest', () => {
  const quietSources = {
    rss: new FakeSourceFetcher('rss', {}),
    github: new FakeSourceFetcher('github', {}),
  };

  it('logs the model calls of each week it runs with that week, in one process', async () => {
    const loaded = loadedConfig();
    useLoggingProvider(modelsInUse(loaded.profile, loaded.config.guards));
    const { deps } = await buildApp(loaded);
    const runDeps = { ...deps, store: new MemoryRunStore(), fetchers: quietSources };

    await runDigest(runDeps, { weekId: WEEK_A, dryRun: true });
    await runDigest(runDeps, { weekId: WEEK_B, dryRun: true });

    expect(logLines(HEALTH_CALL).map((line) => line.runId)).toEqual([WEEK_A, WEEK_B]);
  });

  it('logs the model calls a step makes with the week', async () => {
    const loaded = loadedConfig();
    useLoggingProvider(modelsInUse(loaded.profile, loaded.config.guards));
    const { deps } = await buildApp(loaded);
    const recent = makeItem({ publishedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const runDeps = {
      ...deps,
      store: new MemoryRunStore(),
      fetchers: {
        ...quietSources,
        rss: new FakeSourceFetcher('rss', { 'example-feed': [recent] }),
      },
    };

    await runDigest(runDeps, { weekId: WEEK_A, dryRun: true });

    const calls = logLines(MODEL_CALL);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((line) => line.runId === WEEK_A)).toBe(true);
    // Each call was made by a step, and says which; the readiness probe before the steps did not.
    expect(calls.every((line) => typeof line.step === 'string')).toBe(true);
    expect(calls.map((line) => line.step)).toContain('guardInput');
    const [probe] = logLines(HEALTH_CALL);
    expect(probe?.runId).toBe(WEEK_A);
    expect(probe).not.toHaveProperty('step');
  });

  it('logs a fetcher warning raised during collect with the week', async () => {
    const loaded = loadedConfig();
    useLoggingProvider(modelsInUse(loaded.profile, loaded.config.guards));
    const { deps } = await buildApp(loaded);
    const logger = loggerGivenTo(createRssFetcher);
    const warning: SourceFetcher = {
      kind: 'rss',
      fetch: (source) => {
        logger.warn(FETCHER_WARNING, { sourceId: source.id });
        return Promise.resolve([]);
      },
    };
    const runDeps = {
      ...deps,
      store: new MemoryRunStore(),
      fetchers: { ...quietSources, rss: warning },
    };

    await runDigest(runDeps, { weekId: WEEK_A, dryRun: true });

    const lines = logLines(FETCHER_WARNING);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.runId === WEEK_A && line.step === 'collect')).toBe(true);
  });
});

describe('the tracer the app hands out', () => {
  function recordingTracer(): {
    tracer: TracingHandle;
    spans: [string, LogFields][];
    shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>;
  } {
    const spans: [string, LogFields][] = [];
    const shutdown = vi.fn(() => Promise.resolve());
    const tracer: TracingHandle = {
      span: (name, attributes, fn) => {
        spans.push([name, attributes]);
        return fn();
      },
      shutdown,
    };
    return { tracer, spans, shutdown };
  }

  it('passes every span, with its attributes, to the real tracer', async () => {
    const { tracer, spans } = recordingTracer();
    vi.mocked(createTracer).mockReturnValueOnce(tracer);
    const { deps } = await buildApp(loadedConfig());

    await inRun(deps.tracer, WEEK_A, () =>
      deps.tracer.span('collect', { step: 'collect' }, nothing),
    );

    expect(spans).toEqual([
      ['runDigest', { runId: WEEK_A, dryRun: false }],
      ['collect', { step: 'collect' }],
    ]);
  });

  it('returns what the span returns', async () => {
    const { deps } = await buildApp(loadedConfig());

    await expect(inRun(deps.tracer, WEEK_A, () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('rejects with the very error the span failed with, and keeps no run id behind', async () => {
    useLoggingProvider();
    const { deps } = await buildApp(loadedConfig());
    const failure = new Error('step failed');

    await expect(inRun(deps.tracer, WEEK_A, () => Promise.reject(failure))).rejects.toBe(failure);
    await deps.model.generate(REQUEST);

    expect(logLines(MODEL_CALL).map((line) => line.runId)).toEqual([undefined]);
  });

  it('keeps no run id behind when the real tracer throws at once', async () => {
    useLoggingProvider();
    const { tracer } = recordingTracer();
    vi.mocked(createTracer).mockReturnValueOnce({
      ...tracer,
      span: (name, attributes, fn) => {
        if (name === 'runDigest') throw new Error('tracer is broken');
        return tracer.span(name, attributes, fn);
      },
    });
    const { deps } = await buildApp(loadedConfig());

    expect(() => inRun(deps.tracer, WEEK_A, nothing)).toThrow('tracer is broken');
    await deps.model.generate(REQUEST);

    expect(logLines(MODEL_CALL).map((line) => line.runId)).toEqual([undefined]);
  });

  it('still shuts the real tracer down on close', async () => {
    const { tracer, shutdown } = recordingTracer();
    vi.mocked(createTracer).mockReturnValueOnce(tracer);
    const app = await buildApp(loadedConfig());

    await app.close();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});

describe('the real Ollama adapter', () => {
  const chatReply = (): Response =>
    new Response('{"message":{"content":"hi"},"done":true}\n', { status: 200 });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('logs a retried call and its result with the run id', async () => {
    // Only the retry back-off is faked; a timer the run starts keeps the run's context.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const replies = [() => new Response('overloaded', { status: 503 }), chatReply];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.resolve((replies.shift() ?? chatReply)())),
    );
    const { deps } = await buildApp(loadedConfig());

    const call = inRun(deps.tracer, WEEK_A, () => deps.model.generate(REQUEST));
    await vi.advanceTimersByTimeAsync(1_000);
    await call;

    const lines = logLines().filter((line) => line.msg.startsWith('ollama call'));
    expect(lines.map((line) => [line.msg, line.level, line.runId, line.role])).toEqual([
      ['ollama call failed, retrying', 'warn', WEEK_A, 'write'],
      ['ollama call', 'info', WEEK_A, 'write'],
    ]);
  });

  it('logs a call that was aborted with the run id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );
    const { deps } = await buildApp(loadedConfig());
    const controller = new AbortController();

    const call = inRun(deps.tracer, WEEK_A, () =>
      deps.model.generate({ ...REQUEST, signal: controller.signal }),
    );
    await nextTurn();
    controller.abort(new Error('stop'));
    await expect(call).rejects.toThrow();

    expect(logLines('ollama call aborted')).toEqual([
      expect.objectContaining({ level: 'warn', runId: WEEK_A, role: 'write' }),
    ]);
  });
});
