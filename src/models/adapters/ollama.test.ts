import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PROFILES } from '../../config/profiles';
import { DigestError } from '../../shared/errors';
import { generateStructured } from '../structured';
import {
  BASE_URL,
  chatOk,
  DECIDE,
  fakeFetch,
  fixture,
  hang,
  json,
  ndjson,
  recordingLogger,
  sequence,
  WRITE,
  type Handler,
  type Line,
} from './__fixtures__/ollamaHarness';
import { createOllamaProvider, type OllamaProviderOptions } from './ollama';
import { effectiveTemperature, effectiveThink } from './chat/chatSettings';

// The three calls are tested one by one in call/, chat/, decide/ and health/. These cases check
// that the provider wires them: options reach the right call, and the port behaves as a whole.

function setup(handler: Handler, overrides: Partial<OllamaProviderOptions> = {}) {
  const fake = fakeFetch(handler);
  const lines: Line[] = [];
  const provider = createOllamaProvider({
    baseUrl: BASE_URL,
    profile: PROFILES.light,
    fetch: fake.fetch,
    logger: recordingLogger(lines),
    ...overrides,
  });
  return { provider, calls: fake.calls, lines };
}

describe('createOllamaProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends generate to /api/chat with the profile model and the configured sampling', async () => {
    const { provider, calls, lines } = setup(sequence(chatOk), {
      think: { write: 'low' },
      seed: 42,
      temperature: { write: 0.7 },
    });

    const result = await provider.generate(WRITE);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `${BASE_URL}/api/chat`, method: 'POST' });
    expect(calls[0]!.body).toEqual({
      model: 'gemma4:e4b-mlx',
      messages: [
        { role: 'system', content: 'You write digests.' },
        { role: 'user', content: 'Summarize.' },
      ],
      stream: true,
      think: 'low',
      options: { temperature: 0.7, seed: 42 },
    });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 9 });
    expect(lines[0]).toMatchObject({ level: 'info', message: 'ollama call' });
  });

  it('sends decide to /v1/systemone with the recorded request', async () => {
    const { provider, calls } = setup(
      sequence(() => json(200, fixture('systemone-strands-decider.json'))),
    );

    const result = await provider.decide(DECIDE);

    expect(calls[0]).toMatchObject({ url: `${BASE_URL}/v1/systemone`, method: 'POST' });
    expect(calls[0]!.body).toEqual(fixture('systemone-request.json'));
    expect(result.model).toBe('strands-decider:2b-mlx-bf16');
  });

  it('asks health for the version and the model list', async () => {
    const { provider, calls } = setup((call) =>
      call.url.endsWith('/api/version')
        ? json(200, fixture('version.json'))
        : json(200, fixture('tags.json')),
    );

    const result = await provider.health();

    expect(result).toMatchObject({ reachable: true, version: '0.40.4' });
    expect(calls.map((call) => call.url).sort()).toEqual([
      `${BASE_URL}/api/tags`,
      `${BASE_URL}/api/version`,
    ]);
  });

  it('takes a server URL with a trailing slash', async () => {
    const { provider, calls } = setup(sequence(chatOk), { baseUrl: `${BASE_URL}/` });

    await provider.generate(WRITE);

    expect(calls[0]!.url).toBe(`${BASE_URL}/api/chat`);
  });

  it('gives every call the configured retry count', async () => {
    const { provider, calls } = setup(
      sequence(() => json(500, { error: 'boom' })),
      { retries: 0 },
    );

    await expect(provider.generate(WRITE)).rejects.toThrow(DigestError);
    await expect(provider.decide(DECIDE)).rejects.toThrow(DigestError);

    expect(calls).toHaveLength(2);
  });

  it('waits retryBaseDelayMs, not the default second, between attempts', async () => {
    const { provider, calls } = setup(
      sequence(() => json(500, { error: 'boom' })),
      { retries: 2, retryBaseDelayMs: 1 },
    );
    const started = performance.now();

    await expect(provider.generate(WRITE)).rejects.toThrow(DigestError);

    expect(calls).toHaveLength(3);
    expect(performance.now() - started).toBeLessThan(900);
  });

  it('keeps the password of the server URL out of the request and out of a failure', async () => {
    const password = 'S3cretPw';
    const { provider, calls, lines } = setup(
      (call) => {
        throw new TypeError(`fetch failed for ${call.url}`);
      },
      { baseUrl: `http://user:${password}@127.0.0.1:11434`, retries: 0 },
    );

    const error = await provider.generate(WRITE).catch((e: unknown) => e);

    expect(calls[0]!.url).toBe(`${BASE_URL}/api/chat`);
    expect((error as DigestError).message).toContain(`${BASE_URL}/api/chat`);
    expect(JSON.stringify([(error as DigestError).message, lines])).not.toContain(password);
  });

  it('does not follow a redirect, and does not ask again', async () => {
    const { provider, calls } = setup(
      () =>
        new Response(null, { status: 307, headers: { location: 'https://other.test/api/chat' } }),
    );

    const error = await provider.generate(WRITE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DigestError);
    expect((error as DigestError).message).toContain('answered /api/chat with a redirect');
    expect((error as DigestError).message).toContain('set OLLAMA_URL');
    expect(calls).toHaveLength(1);
  });

  it('uses the global fetch when none is injected', async () => {
    const fake = fakeFetch(sequence(chatOk));
    vi.stubGlobal('fetch', fake.fetch);
    const provider = createOllamaProvider({
      baseUrl: BASE_URL,
      profile: PROFILES.light,
      logger: recordingLogger([]),
    });

    await provider.generate(WRITE);

    expect(fake.calls).toHaveLength(1);
  });

  it('keeps the helpers its callers import from here', () => {
    expect(effectiveThink({ write: 'low' }, 'write')).toBe('low');
    expect(effectiveTemperature(undefined, 'write')).toBe(0.2);
  });
});

describe('createOllamaProvider timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives every call the configured per-role timeout', async () => {
    const { provider } = setup((call) => hang(call.signal), {
      retries: 0,
      coldStartMs: 0,
      timeoutsMs: { write: 5_000, classify: 3_000 },
    });

    const writing = expect(provider.generate(WRITE)).rejects.toThrow('timed out after 5000 ms');
    const deciding = expect(provider.decide(DECIDE)).rejects.toThrow('timed out after 3000 ms');
    await vi.advanceTimersByTimeAsync(5_000);

    await writing;
    await deciding;
  });
});

describe('a reply cut at the token limit', () => {
  const SCHEMA = z.object({ headline: z.string(), items: z.array(z.string()) });
  const COMPLETE = '{"headline":"Week 42","items":["a","b"]}';
  const cutReply = (): Response =>
    ndjson({ message: { content: COMPLETE.slice(0, 25) }, done: true, done_reason: 'length' });
  const goodReply = (): Response =>
    ndjson({ message: { content: COMPLETE }, done: true, done_reason: 'stop' });

  it('is not valid JSON, so structured generation sends it to its one repair attempt', async () => {
    const { provider, calls } = setup(sequence(cutReply, goodReply));

    const result = await generateStructured(provider, WRITE, SCHEMA, 'write');

    expect(result.repaired).toBe(true);
    expect(result.value).toEqual({ headline: 'Week 42', items: ['a', 'b'] });
    expect(calls).toHaveLength(2);
    const repairPrompt = (calls[1]!.body as { messages: { content: string }[] }).messages[1]!
      .content;
    expect(repairPrompt).toContain('invalid JSON');
    expect(repairPrompt).toContain(COMPLETE.slice(0, 25));
  });

  it('fails the step, with the usual message, when the repair is cut as well', async () => {
    const { provider, calls } = setup(sequence(cutReply));

    await expect(generateStructured(provider, WRITE, SCHEMA, 'write')).rejects.toThrow(
      'Model output for write failed validation after one repair attempt',
    );
    expect(calls).toHaveLength(2);
  });
});
