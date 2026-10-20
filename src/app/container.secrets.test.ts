import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClefPolicyGuard, createClefRubricGuard } from '../guards/adapters/clefPolicy';
import { createGraniteGroundednessGuard, createGraniteRiskGuard } from '../guards/adapters/granite';
import { DeliveryError } from '../delivery/adapters/errors/deliveryError';
import { createMarkdownFileDelivery } from '../delivery/adapters/markdownFile';
import { createSlackDelivery } from '../delivery/adapters/slack';
import { createSmtpDelivery } from '../delivery/adapters/smtp';
import { createOllamaProvider } from '../models/adapters/ollama';
import { createRssFetcher } from '../sources/adapters/rss';
import { createGithubReleasesFetcher } from '../sources/adapters/githubReleases';
import { createFsRunStore } from '../store/adapters/fsRunStore';
import { buildApp } from './container';
import type { LoadedConfig } from '../config/load';
import { resolveProfile, type Platform } from '../config/profiles';
import {
  EnvSchema,
  SecretsSchema,
  type ConfigInput,
  type Env,
  type Secrets,
} from '../config/schema';
import { createLogger } from '../observability/logger';
import { createTracer } from '../observability/tracing';
import { DigestError } from '../shared/errors';
import type { Delivery, DigestMessage } from '../delivery/Delivery';
import { makeConfig, makeRunRecord } from '../../test/builders';
import { CapturingDelivery, MemoryRunStore } from '../../test/fakes';

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
vi.mock('../store/adapters/fsRunStore', (load) => wrapFactories(load, ['createFsRunStore']));
vi.mock('../delivery/adapters/markdownFile', (load) =>
  wrapFactories(load, ['createMarkdownFileDelivery']),
);
vi.mock('../delivery/adapters/smtp', (load) => wrapFactories(load, ['createSmtpDelivery']));
vi.mock('../delivery/adapters/slack', (load) => wrapFactories(load, ['createSlackDelivery']));
vi.mock('../sources/adapters/rss', (load) => wrapFactories(load, ['createRssFetcher']));
vi.mock('../sources/adapters/githubReleases', (load) =>
  wrapFactories(load, ['createGithubReleasesFetcher']),
);
vi.mock('../guards/adapters/clefPolicy', (load) =>
  wrapFactories(load, ['createClefPolicyGuard', 'createClefRubricGuard']),
);
vi.mock('../guards/adapters/granite', (load) =>
  wrapFactories(load, ['createGraniteRiskGuard', 'createGraniteGroundednessGuard']),
);
vi.mock('../observability/logger', (load) => wrapFactories(load, ['createLogger']));
vi.mock('../observability/tracing', (load) => wrapFactories(load, ['createTracer']));

const SMTP_PASSWORD = 'smtp-password-4f9a';
const SLACK_WEBHOOK_PATH = '/services/T000/B000/slack-secret-7c1e';
const SLACK_WEBHOOK_URL = `https://hooks.slack.test${SLACK_WEBHOOK_PATH}`;
const GITHUB_TOKEN = 'ghp_github-token-82bd';
const ALL_SECRETS: Secrets = {
  SMTP_PASSWORD,
  SLACK_WEBHOOK_URL,
  GITHUB_TOKEN,
};
const SECRET_VALUES = [SMTP_PASSWORD, SLACK_WEBHOOK_URL, GITHUB_TOKEN];

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

describe('buildApp secrets', () => {
  it('names SMTP_PASSWORD, not any value, when email is configured without it', async () => {
    const loaded = loadedConfig({
      config: { delivery: { email: EMAIL } },
      secrets: { SLACK_WEBHOOK_URL, GITHUB_TOKEN },
    });

    const failure = await buildApp(loaded).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DigestError);
    expect((failure as DigestError).message).toContain('SMTP_PASSWORD');
    for (const value of SECRET_VALUES)
      expect((failure as DigestError).message).not.toContain(value);
  });

  it('names SLACK_WEBHOOK_URL, not any value, when Slack is enabled without it', async () => {
    const loaded = loadedConfig({
      config: { delivery: { slack: { enabled: true } } },
      secrets: { SMTP_PASSWORD, GITHUB_TOKEN },
    });

    const failure = await buildApp(loaded).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DigestError);
    expect((failure as DigestError).message).toContain('SLACK_WEBHOOK_URL');
    for (const value of SECRET_VALUES)
      expect((failure as DigestError).message).not.toContain(value);
  });

  it('starts nothing before it knows the secrets are there', async () => {
    const loaded = loadedConfig({
      config: { delivery: { email: EMAIL } },
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318/v1/traces' },
    });

    await expect(buildApp(loaded)).rejects.toBeInstanceOf(DigestError);

    expect(calledWith(createTracer)).toBe(0);
    expect(calledWith(createLogger)).toBe(0);
  });

  it('redacts every non-empty secret value in the logger and the tracer', async () => {
    const loaded = loadedConfig({
      config: { delivery: { email: EMAIL, slack: { enabled: true } } },
      secrets: ALL_SECRETS,
    });

    await buildApp(loaded);

    // The secret path of the webhook goes in too: a message can carry it without the host.
    const expected = [...SECRET_VALUES, SLACK_WEBHOOK_PATH].sort();
    const loggerValues = [...(firstCallOptions(createLogger).redactValues ?? [])];
    const tracerValues = [...(firstCallOptions(createTracer).redactValues ?? [])];
    expect([...loggerValues].sort()).toEqual(expected);
    expect([...tracerValues].sort()).toEqual(expected);
  });

  it('redacts the password of OLLAMA_URL, as written and decoded, in the logger and the tracer', async () => {
    const loaded = loadedConfig({
      env: { OLLAMA_URL: 'http://user:p%40ss%2Fword@ollama.test:11434' },
    });

    await buildApp(loaded);

    const expected = ['p%40ss%2Fword', 'p@ss/word'];
    expect([...(firstCallOptions(createLogger).redactValues ?? [])].sort()).toEqual(
      expected.sort(),
    );
    expect([...(firstCallOptions(createTracer).redactValues ?? [])].sort()).toEqual(
      expected.sort(),
    );
  });

  it('redacts nothing extra when no secret is set', async () => {
    await buildApp(loadedConfig());

    expect(firstCallOptions(createLogger)).toMatchObject({ redactValues: [] });
  });

  it('keeps a secret out of the log lines the built logger writes', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const loaded = loadedConfig({
      config: { delivery: { email: EMAIL } },
      secrets: { SMTP_PASSWORD },
    });

    const { deps } = await buildApp(loaded);
    deps.logger.error(`login failed for ${SMTP_PASSWORD}`, { password: SMTP_PASSWORD });

    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain(SMTP_PASSWORD);
  });

  it('gives each secret only to the adapter that needs it', async () => {
    const loaded = loadedConfig({
      config: { delivery: { email: EMAIL, slack: { enabled: true } } },
      secrets: ALL_SECRETS,
    });

    await buildApp(loaded);

    const seen = (factory: (...args: never[]) => unknown): string =>
      JSON.stringify(vi.mocked(factory).mock.calls);
    expect(seen(createSmtpDelivery)).toContain(SMTP_PASSWORD);
    expect(seen(createSmtpDelivery)).not.toContain(SLACK_WEBHOOK_URL);
    expect(seen(createSmtpDelivery)).not.toContain(GITHUB_TOKEN);
    expect(seen(createSlackDelivery)).toContain(SLACK_WEBHOOK_URL);
    expect(seen(createSlackDelivery)).not.toContain(SMTP_PASSWORD);
    expect(seen(createSlackDelivery)).not.toContain(GITHUB_TOKEN);
    expect(seen(createGithubReleasesFetcher)).toContain(GITHUB_TOKEN);
    expect(seen(createGithubReleasesFetcher)).not.toContain(SMTP_PASSWORD);

    const others = [
      createOllamaProvider,
      createFsRunStore,
      createRssFetcher,
      createMarkdownFileDelivery,
      createClefPolicyGuard,
      createClefRubricGuard,
      createGraniteRiskGuard,
      createGraniteGroundednessGuard,
    ];
    for (const factory of others) {
      for (const value of SECRET_VALUES) expect(seen(factory)).not.toContain(value);
    }
  });
});

describe('buildApp with a password in OLLAMA_URL', () => {
  const OLLAMA_PASSWORD = 'S3cretPw';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the password out of what the model reports when Ollama does not answer', async () => {
    // Node's fetch quotes the whole URL it is given in some errors.
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: string) => {
      urls.push(input);
      return Promise.reject(new TypeError(`fetch failed for ${input}`));
    });
    const loaded = loadedConfig({
      env: { OLLAMA_URL: `http://user:${OLLAMA_PASSWORD}@ollama.test:11434` },
    });
    const { deps } = await buildApp(loaded);

    const health = await deps.model.health();

    expect(urls.sort()).toEqual([
      'http://ollama.test:11434/api/tags',
      'http://ollama.test:11434/api/version',
    ]);
    expect(health.reachable).toBe(false);
    expect(health.error).toContain('http://ollama.test:11434/api/version');
    expect(JSON.stringify(health)).not.toContain(OLLAMA_PASSWORD);
  });
});

/** Sends fail with `error` until `failures` of them have; then they are kept. */
function flakyDelivery(
  id: Delivery['id'],
  error: Error,
  failures: number,
): { delivery: Delivery; digests: DigestMessage[]; calls: () => number } {
  const digests: DigestMessage[] = [];
  let calls = 0;
  const attempt = (keep: () => void): Promise<void> => {
    calls += 1;
    if (calls <= failures) return Promise.reject(error);
    keep();
    return Promise.resolve();
  };
  const delivery: Delivery = {
    id,
    sendDigest: (message) => attempt(() => digests.push(message)),
    sendFailure: () => attempt(() => undefined),
    clearFailure: () => Promise.resolve(),
  };
  return { delivery, digests, calls: () => calls };
}

const SLACK_ON = { delivery: { slack: { enabled: true } } } as const;
const DIGEST: DigestMessage = { weekId: '2026-W42', subject: 'Digest', markdown: '# Digest' };

describe('buildApp delivery retry and redaction', () => {
  // The built logger writes the "will retry" lines to stdout.
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function slackOf(app: Awaited<ReturnType<typeof buildApp>>): Delivery {
    const slack = app.deps.deliveries.find((delivery) => delivery.id === 'slack');
    if (!slack) throw new Error('no Slack delivery');
    return slack;
  }

  it('tries a delivery again after a transient error', async () => {
    vi.useFakeTimers();
    try {
      const flaky = flakyDelivery(
        'slack',
        new DeliveryError('Slack webhook answered HTTP 503', { status: 503 }),
        2,
      );
      vi.mocked(createSlackDelivery).mockReturnValueOnce(flaky.delivery);
      const app = await buildApp(loadedConfig({ config: SLACK_ON, secrets: ALL_SECRETS }));

      const sending = slackOf(app).sendDigest(DIGEST);
      await vi.advanceTimersByTimeAsync(5_000 + 10_000);
      await sending;

      expect(flaky.calls()).toBe(3);
      expect(flaky.digests).toEqual([DIGEST]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after two retries and throws the last error', async () => {
    vi.useFakeTimers();
    try {
      const flaky = flakyDelivery(
        'slack',
        new DeliveryError('Slack webhook answered HTTP 503', { status: 503 }),
        99,
      );
      vi.mocked(createSlackDelivery).mockReturnValueOnce(flaky.delivery);
      const app = await buildApp(loadedConfig({ config: SLACK_ON, secrets: ALL_SECRETS }));

      const outcome = expect(
        slackOf(app).sendFailure({ weekId: '2026-W42', message: 'x' }),
      ).rejects.toThrow('HTTP 503');
      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;

      expect(flaky.calls()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry an error that a retry cannot fix', async () => {
    const flaky = flakyDelivery('slack', new Error('Slack webhook answered HTTP 404'), 99);
    vi.mocked(createSlackDelivery).mockReturnValueOnce(flaky.delivery);
    const app = await buildApp(loadedConfig({ config: SLACK_ON, secrets: ALL_SECRETS }));

    await expect(slackOf(app).sendDigest(DIGEST)).rejects.toThrow('HTTP 404');

    expect(flaky.calls()).toBe(1);
  });

  it('takes known secrets out of a digest before any channel sees it', async () => {
    const capture = new CapturingDelivery('slack');
    vi.mocked(createSlackDelivery).mockReturnValueOnce(capture);
    const app = await buildApp(loadedConfig({ config: SLACK_ON, secrets: ALL_SECRETS }));

    await slackOf(app).sendDigest({
      ...DIGEST,
      subject: `a ${SMTP_PASSWORD}`,
      markdown: `b ${GITHUB_TOKEN}`,
    });

    expect(capture.digests).toEqual([
      { ...DIGEST, subject: 'a [redacted]', markdown: 'b [redacted]' },
    ]);
  });

  it('takes known secrets out of a failure note, and the secret part of the webhook URL', async () => {
    const capture = new CapturingDelivery('slack');
    vi.mocked(createSlackDelivery).mockReturnValueOnce(capture);
    const app = await buildApp(loadedConfig({ config: SLACK_ON, secrets: ALL_SECRETS }));

    await slackOf(app).sendFailure({
      weekId: '2026-W42',
      step: 'deliver',
      message: `POST ${SLACK_WEBHOOK_PATH} failed`,
    });

    expect(capture.failures).toEqual([
      { weekId: '2026-W42', step: 'deliver', message: 'POST [redacted] failed' },
    ]);
  });

  it('wraps the always-on Markdown channel too', async () => {
    const capture = new CapturingDelivery('markdown');
    vi.mocked(createMarkdownFileDelivery).mockReturnValueOnce(capture);
    const app = await buildApp(loadedConfig({ secrets: ALL_SECRETS }));

    await app.deps.deliveries[0]?.sendDigest({ ...DIGEST, markdown: `k ${GITHUB_TOKEN}` });

    expect(capture.digests[0]?.markdown).toBe('k [redacted]');
  });
});

describe('buildApp run store redaction', () => {
  it('redacts the run record and the artifacts before the store gets them', async () => {
    const memory = new MemoryRunStore();
    vi.mocked(createFsRunStore).mockReturnValueOnce(memory);
    const { deps } = await buildApp(loadedConfig({ secrets: ALL_SECRETS }));

    await deps.store.saveRunRecord(
      makeRunRecord({ status: 'failed', error: { message: `refused ${SMTP_PASSWORD}` } }),
    );
    await deps.store.saveArtifact('2026-W42', 'error.json', `{"m":"${GITHUB_TOKEN}"}`);

    expect(memory.records.get('2026-W42')?.error?.message).toBe('refused [redacted]');
    expect(memory.artifacts.get('2026-W42/error.json')).toBe('{"m":"[redacted]"}');
  });

  it('reads back what the store holds', async () => {
    const memory = new MemoryRunStore();
    memory.records.set('2026-W42', makeRunRecord({ status: 'quiet' }));
    vi.mocked(createFsRunStore).mockReturnValueOnce(memory);
    const { deps } = await buildApp(loadedConfig());

    await expect(deps.store.getRunRecord('2026-W42')).resolves.toMatchObject({ status: 'quiet' });
  });
});
