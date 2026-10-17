import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createOllamaProvider,
  DEFAULT_THINK,
  DEFAULT_TIMEOUTS_MS,
  effectiveTemperature,
  effectiveThink,
  type OllamaProviderOptions,
} from '../../../src/adapters/models/ollama.js';
import { MIN_STATE_CHARS } from '../../../src/adapters/models/systemone.js';
import { MODEL_TAGS, PROFILES } from '../../../src/config/profiles.js';
import { generateStructured } from '../../../src/core/structured.js';
import type { DecideRequest, DecisionQuestion } from '../../../src/ports/ModelProvider.js';
import { DigestError } from '../../../src/shared/errors.js';
import type { LogFields, Logger } from '../../../src/shared/telemetry.js';

const BASE_URL = 'http://127.0.0.1:11434';
const UNREACHABLE =
  'Ollama is not reachable at http://127.0.0.1:11434. Start the Ollama app or run `ollama serve`.';

function fixtureText(name: string): string {
  return readFileSync(new URL(`../../fixtures/ollama/${name}`, import.meta.url), 'utf8');
}

function fixture(name: string): unknown {
  return JSON.parse(fixtureText(name)) as unknown;
}

function ndjson(...lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n'), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refused(): never {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
    code: 'ECONNREFUSED',
  });
  throw new TypeError('fetch failed', { cause });
}

/** A fetch that never answers; it rejects only when its signal aborts, like the real one. */
function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason as Error);
    signal?.addEventListener('abort', () => {
      reject(signal.reason as Error);
    });
  });
}

interface Call {
  url: string;
  method: string;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

type Handler = (call: Call, index: number) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  // async, so a handler that throws becomes a rejected fetch, like a real network failure.
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: input instanceof Request ? input.url : input.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      signal: init?.signal,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch: fn, calls };
}

/** Replies in order; the last reply repeats. */
function sequence(...replies: (() => Response | Promise<Response>)[]): Handler {
  return (_call, index) => replies[Math.min(index, replies.length - 1)]!();
}

interface Line {
  level: string;
  message: string;
  fields: LogFields;
}

function recordingLogger(lines: Line[], base: LogFields = {}): Logger {
  const log =
    (level: string) =>
    (message: string, fields: LogFields = {}): void => {
      lines.push({ level, message, fields: { ...base, ...fields } });
    };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (fields) => recordingLogger(lines, { ...base, ...fields }),
  };
}

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

const chatOk = (): Response =>
  new Response(fixtureText('chat-stream.ndjson'), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });

const WRITE = { role: 'write', system: 'You write digests.', prompt: 'Summarize.' } as const;

const QUESTIONS = {
  hype: {
    type: 'yesno',
    instructions: 'Is this release note mostly marketing hype with no concrete technical change?',
    criteria: { yes: 'mostly hype', no: 'concrete technical change' },
  },
  area: {
    type: 'choice',
    instructions: 'Which engineering area does this release belong to?',
    options: {
      inference: 'model serving and inference',
      training: 'model training',
      platform: null,
    },
  },
  relevance: {
    type: 'score',
    instructions: 'How relevant is this release to an AI platform engineer?',
    levels: ['none', 'low', 'medium', 'high'],
  },
} as const satisfies Record<string, DecisionQuestion>;

const DECIDE: DecideRequest = {
  role: 'classify',
  state:
    'Release: vLLM v0.12.0 adds speculative decoding for Llama 4 and cuts p99 latency by 30% on H100.',
  questions: QUESTIONS,
};

describe('generate', () => {
  it('posts a non-streaming chat for the role model with system and user messages', async () => {
    const { provider, calls } = setup(sequence(chatOk));

    await provider.generate(WRITE);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/api/chat`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      model: 'gemma4:e4b-mlx',
      messages: [
        { role: 'system', content: 'You write digests.' },
        { role: 'user', content: 'Summarize.' },
      ],
      stream: true,
      options: { temperature: 0.2 },
    });
  });

  it('uses an explicit writer model, the JSON schema as format and the temperature', async () => {
    const { provider, calls } = setup(sequence(chatOk));
    const jsonSchema = { type: 'object', properties: { title: { type: 'string' } } };

    const result = await provider.generate({
      ...WRITE,
      model: 'nemotron-3.5-lightning:30b-mlx',
      jsonSchema,
      temperature: 0.2,
    });

    expect(calls[0]!.body).toMatchObject({
      model: 'nemotron-3.5-lightning:30b-mlx',
      stream: true,
      format: jsonSchema,
      options: { temperature: 0.2 },
    });
    expect(result.model).toBe('nemotron-3.5-lightning:30b-mlx');
  });

  it('resolves the first model of the role from the profile', async () => {
    const { provider, calls } = setup(sequence(chatOk), { profile: PROFILES.quality });
    await provider.generate({ ...WRITE, role: 'judge' });
    expect(calls[0]!.body).toMatchObject({ model: 'clef:latest' });
  });

  it('maps the reply text, token counts and latency', async () => {
    const { provider } = setup(sequence(chatOk));

    const result = await provider.generate(WRITE);

    expect(result).toMatchObject({
      model: 'gemma4:e4b-mlx',
      text: '{"title":"vLLM 0.12 adds speculative decoding"}',
      usage: { inputTokens: 42, outputTokens: 9 },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('counts missing token fields as zero', async () => {
    const { provider } = setup(sequence(() => ndjson({ message: { content: 'hi' }, done: true })));
    const result = await provider.generate(WRITE);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('logs one line per call with role, model, latency and tokens', async () => {
    const { provider, lines } = setup(sequence(chatOk));

    await provider.generate(WRITE);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      fields: {
        role: 'write',
        model: 'gemma4:e4b-mlx',
        op: 'generate',
        inputTokens: 42,
        outputTokens: 9,
        attempts: 1,
      },
    });
    expect(lines[0]!.fields.latencyMs).toEqual(expect.any(Number));
  });

  it('fails clearly when the profile has no model for the role', async () => {
    const { provider, calls } = setup(sequence(chatOk));
    await expect(provider.generate({ ...WRITE, role: 'judge' })).rejects.toThrow(
      'No model is configured for role judge in profile light',
    );
    expect(calls).toHaveLength(0);
  });

  it('rejects a stream line that does not match the chat shape', async () => {
    const { provider, calls } = setup(sequence(() => ndjson({ done: 'yes' })));
    await expect(provider.generate(WRITE)).rejects.toThrow(/unexpected \/api\/chat response/);
    expect(calls).toHaveLength(1);
  });

  it('rejects a stream that ends before the reply is done', async () => {
    const { provider } = setup(
      sequence(() => ndjson({ message: { content: 'half' }, done: false })),
    );
    await expect(provider.generate(WRITE)).rejects.toThrow(
      'Ollama ended the /api/chat stream before the reply was done',
    );
  });

  it('rejects a body that is not JSON without retrying', async () => {
    const { provider, calls } = setup(sequence(() => new Response('<html>proxy</html>')));
    await expect(provider.generate(WRITE)).rejects.toThrow(
      'Ollama returned a non-JSON /api/chat response: <html>proxy</html>',
    );
    expect(calls).toHaveLength(1);
  });

  it('warns when the reply hit the token limit', async () => {
    const { provider, lines } = setup(
      sequence(() =>
        ndjson({ message: { content: 'cut' }, done: true, done_reason: 'length', eval_count: 5 }),
      ),
    );
    const result = await provider.generate(WRITE);
    expect(result.text).toBe('cut');
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'ollama reply hit the token limit',
        fields: expect.objectContaining({ structured: false }) as unknown,
      }),
    );
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

  it('is logged as an incomplete structured reply when a schema was requested', async () => {
    const { provider, lines } = setup(sequence(cutReply));

    await provider.generate({ ...WRITE, jsonSchema: z.toJSONSchema(SCHEMA) });

    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'ollama reply hit the token limit',
        fields: expect.objectContaining({ structured: true }) as unknown,
      }),
    );
  });
});

describe('effectiveThink', () => {
  it('returns the configured setting over the adapter default', () => {
    expect(effectiveThink({ guardRisk: true }, 'guardRisk')).toBe(true);
    expect(effectiveThink({ write: 'high' }, 'write')).toBe('high');
  });

  it('keeps an explicit false instead of falling back to the default', () => {
    expect(effectiveThink({ guardRisk: false, classify: false }, 'classify')).toBe(false);
  });

  it('returns the adapter default for a role without a setting', () => {
    expect(effectiveThink(undefined, 'guardRisk')).toBe(false);
    expect(effectiveThink({ write: 'low' }, 'guardRisk')).toBe(false);
  });

  it('returns undefined when neither the config nor the adapter says anything', () => {
    expect(effectiveThink(undefined, 'classify')).toBeUndefined();
    expect(effectiveThink({}, 'write')).toBeUndefined();
  });

  it('is what generate sends', async () => {
    const think = { classify: 'medium', guardRisk: true } as const;
    const { provider, calls } = setup(sequence(chatOk), { think });

    await provider.generate({ role: 'classify', system: 's', prompt: 'p' });
    await provider.generate({ role: 'guardRisk', system: 's', prompt: 'p' });

    expect(calls.map((call) => (call.body as { think?: unknown }).think)).toEqual(
      (['classify', 'guardRisk'] as const).map((role) => effectiveThink(think, role)),
    );
  });
});

describe('sampling', () => {
  it.each([
    ['write', 0.2],
    ['classify', 0],
    ['guardPolicy', 0],
    ['guardRisk', 0],
    ['judge', 0],
  ] as const)('defaults the %s temperature to %s', async (role, temperature) => {
    const { provider, calls } = setup(sequence(chatOk));

    await provider.generate({ role, system: 's', prompt: 'p', model: 'any:model' });

    expect((calls[0]!.body as { options: unknown }).options).toEqual({ temperature });
  });

  it('sends the provider seed when the request has none', async () => {
    const { provider, calls } = setup(sequence(chatOk), { seed: 42 });

    await provider.generate(WRITE);

    expect(calls[0]!.body).toMatchObject({ options: { seed: 42, temperature: 0.2 } });
  });

  it('sends no seed when none is set anywhere', async () => {
    const { provider, calls } = setup(sequence(chatOk));

    await provider.generate(WRITE);

    expect((calls[0]!.body as { options: object }).options).not.toHaveProperty('seed');
  });

  it('lets the request seed and temperature win, including a temperature of 0', async () => {
    const { provider, calls } = setup(sequence(chatOk), { seed: 42, temperature: { write: 0.9 } });

    await provider.generate({ ...WRITE, seed: 5, temperature: 0 });

    expect(calls[0]!.body).toMatchObject({ options: { seed: 5, temperature: 0 } });
  });

  it('applies a configured per-role temperature over the default', async () => {
    const { provider, calls } = setup(sequence(chatOk), { temperature: { write: 0.7 } });

    await provider.generate(WRITE);

    expect(calls[0]!.body).toMatchObject({ options: { temperature: 0.7 } });
  });

  it('exposes the temperature a role sends', () => {
    expect(effectiveTemperature(undefined, 'write')).toBe(0.2);
    expect(effectiveTemperature({ write: 0 }, 'write')).toBe(0);
  });
});

describe('think', () => {
  const GUARD = { role: 'guardRisk', system: 'Judge the text.', prompt: 'Text.' } as const;

  it('defaults guardRisk to think false', async () => {
    const { provider, calls } = setup(sequence(chatOk));

    await provider.generate(GUARD);

    expect(DEFAULT_THINK).toEqual({ guardRisk: false });
    expect(calls[0]!.body).toMatchObject({ model: MODEL_TAGS.graniteGuardian, think: false });
  });

  it('sends no think field for a role without a setting', async () => {
    const { provider, calls } = setup(sequence(chatOk));

    await provider.generate(WRITE);

    expect(calls[0]!.body).not.toHaveProperty('think');
  });

  it('sends an override for a role as given', async () => {
    const { provider, calls } = setup(sequence(chatOk), { think: { write: 'low' } });

    await provider.generate(WRITE);

    expect(calls[0]!.body).toMatchObject({ think: 'low' });
  });

  it('lets an override turn guardRisk thinking on', async () => {
    const { provider, calls } = setup(sequence(chatOk), { think: { guardRisk: true } });

    await provider.generate(GUARD);

    expect(calls[0]!.body).toMatchObject({ think: true });
  });

  it('keeps the guardRisk default when only another role is overridden', async () => {
    const { provider, calls } = setup(sequence(chatOk), { think: { write: 'high' } });

    await provider.generate(GUARD);

    expect(calls[0]!.body).toMatchObject({ think: false });
  });

  it('never sends think on a systemone call', async () => {
    const { provider, calls } = setup(
      sequence(() => json(200, fixture('systemone-strands-decider.json'))),
      { think: { classify: true, guardRisk: false } },
    );

    await provider.decide(DECIDE);

    expect(calls[0]!.body).not.toHaveProperty('think');
  });

  it('sends an explicit false for a role that has no default', async () => {
    const { provider, calls } = setup(sequence(chatOk), { think: { write: false } });

    await provider.generate(WRITE);

    expect(calls[0]!.body).toMatchObject({ think: false });
  });

  it('logs the effective think setting, or default when the role has none', async () => {
    const { provider, lines } = setup(sequence(chatOk), { think: { write: 'medium' } });

    await provider.generate(GUARD);
    await provider.generate(WRITE);
    await provider.generate({ ...WRITE, role: 'classify' });

    const calls = lines.filter((l) => l.message === 'ollama call');
    expect(calls.map((l) => l.fields.think)).toEqual([false, 'medium', 'default']);
  });

  it('logs the think setting on failure and token-limit lines too', async () => {
    const failing = setup(
      sequence(() => json(400, { error: 'bad request' })),
      { retries: 0 },
    );
    await expect(failing.provider.generate(GUARD)).rejects.toThrow(DigestError);
    expect(failing.lines.at(-1)).toMatchObject({ level: 'error', fields: { think: false } });

    const cut = setup(
      sequence(() => ndjson({ message: { content: 'cut' }, done: true, done_reason: 'length' })),
      { think: { write: 'high' } },
    );
    await cut.provider.generate(WRITE);
    expect(cut.lines).toContainEqual(
      expect.objectContaining({
        message: 'ollama reply hit the token limit',
        fields: expect.objectContaining({ think: 'high' }) as unknown,
      }),
    );
  });

  it('does not log think on a decide call', async () => {
    const { provider, lines } = setup(
      sequence(() => json(200, fixture('systemone-strands-decider.json'))),
    );

    await provider.decide(DECIDE);

    expect(lines[0]!.fields).not.toHaveProperty('think');
  });
});

describe('decide', () => {
  it('posts the recorded systemone request for the role model', async () => {
    const { provider, calls } = setup(
      sequence(() => json(200, fixture('systemone-strands-decider.json'))),
    );

    await provider.decide(DECIDE);

    expect(calls[0]!.url).toBe(`${BASE_URL}/v1/systemone`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual(fixture('systemone-request.json'));
  });

  it('maps the recorded clef answers, usage and model', async () => {
    const { provider, calls, lines } = setup(
      sequence(() => json(200, fixture('systemone-clef.json'))),
      { profile: PROFILES.quality },
    );

    const result = await provider.decide(DECIDE);

    expect(calls[0]!.body).toMatchObject({ model: 'clef:latest' });
    expect(result.model).toBe('clef:latest');
    expect(result.usage).toEqual({ inputTokens: 359, outputTokens: 0 });
    expect(result.answers.hype).toEqual({ type: 'yesno', probability: 0.023689471299374428 });
    expect(result.answers.area).toMatchObject({ type: 'choice', choice: 'inference' });
    expect(result.answers.relevance).toMatchObject({ type: 'score', level: 2.7116717645265753 });
    expect(lines[0]).toMatchObject({
      level: 'info',
      fields: { role: 'classify', model: 'clef:latest', op: 'decide', inputTokens: 359 },
    });
  });

  it('validates the questions before calling Ollama', async () => {
    const { provider, calls } = setup(sequence(() => json(200, {})));
    const tooMany = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [
        `q${i}`,
        { type: 'yesno', instructions: 'x' } as const,
      ]),
    );
    await expect(provider.decide({ ...DECIDE, questions: tooMany })).rejects.toThrow(
      'decide needs 1-64 questions, got 65',
    );
    expect(calls).toHaveLength(0);
  });

  /** The one question of these tests, as /v1/systemone gets it. */
  const MINOR = { minor: { type: 'yesno', instructions: 'Is this a minor release?' } } as const;
  const MINOR_CHARS = '{"minor":{"type":"noul","instructions":"Is this a minor release?"}}'.length;

  it('trims the state to the strands-decider budget minus the questions, and logs it', async () => {
    const { provider, calls, lines } = setup(
      sequence(() => json(200, fixture('systemone-yesno-no-criteria.json'))),
    );
    const state = `<<<DATA item>>>\n${'a'.repeat(12_000)}\n<<<END DATA>>>`;

    await provider.decide({ role: 'classify', state, questions: MINOR });

    const sent = (calls[0]!.body as { state: string }).state;
    expect(sent).toHaveLength(10_000 - MINOR_CHARS);
    expect(sent.endsWith('<<<END DATA>>>')).toBe(true);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        fields: expect.objectContaining({
          fromChars: state.length,
          toChars: 10_000 - MINOR_CHARS,
          questionChars: MINOR_CHARS,
        }) as unknown,
      }),
    );
  });

  it('trims a state that would fit alone when the questions use up the room', async () => {
    const answer = { type: 'choice', choice: 'area0', probabilities: { area0: 1 }, confidence: 1 };
    const { provider, calls } = setup(sequence(() => json(200, { answers: { area: answer } })));
    const options = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`area${i}`, 'x'.repeat(100)]),
    );
    const questions = { area: { type: 'choice', instructions: 'Which?', options } } as const;
    const state = 'c'.repeat(9_000);

    await provider.decide({ role: 'classify', state, questions });

    const sent = (calls[0]!.body as { state: string }).state;
    const sentQuestions = (calls[0]!.body as { questions: unknown }).questions;
    expect(sent.length).toBeLessThan(state.length);
    expect(sent.length + JSON.stringify(sentQuestions).length).toBeLessThanOrEqual(10_000);
  });

  it('sends the whole state when the state and the questions fit together', async () => {
    const { provider, calls, lines } = setup(
      sequence(() => json(200, fixture('systemone-yesno-no-criteria.json'))),
    );
    const state = 'd'.repeat(10_000 - MINOR_CHARS);

    await provider.decide({ role: 'classify', state, questions: MINOR });

    expect((calls[0]!.body as { state: string }).state).toBe(state);
    expect(lines.filter((line) => line.level === 'warn')).toEqual([]);
  });

  it('keeps a minimum of the state when the questions alone fill the context', async () => {
    const { provider, calls } = setup(
      sequence(() => json(200, fixture('systemone-yesno-no-criteria.json'))),
    );
    const questions = {
      minor: { type: 'yesno', instructions: 'y'.repeat(12_000) },
    } as const;

    await provider.decide({ role: 'classify', state: 'e'.repeat(5_000), questions });

    expect((calls[0]!.body as { state: string }).state).toHaveLength(MIN_STATE_CHARS);
  });

  it('keeps a long state for clef within its larger budget', async () => {
    const { provider, calls } = setup(
      sequence(() => json(200, fixture('systemone-yesno-no-criteria.json'))),
      { profile: PROFILES.quality },
    );
    const state = 'b'.repeat(12_000);

    await provider.decide({
      role: 'classify',
      state,
      questions: { minor: { type: 'yesno', instructions: 'Is this a minor release?' } },
    });

    expect((calls[0]!.body as { state: string }).state).toBe(state);
  });
});

describe('reliability', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a 503 and then succeeds', async () => {
    const { provider, calls, lines } = setup(
      sequence(() => json(503, { error: 'server busy' }), chatOk),
    );

    const pending = provider.generate(WRITE);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.text).toContain('vLLM');
    expect(calls).toHaveLength(2);
    expect(lines.find((l) => l.level === 'warn')).toMatchObject({
      fields: { attempt: 1, error: expect.stringContaining('server busy') as unknown },
    });
    expect(lines.at(-1)).toMatchObject({ level: 'info', fields: { attempts: 2 } });
  });

  it('gives up after two retries on 5xx', async () => {
    const { provider, calls } = setup(sequence(() => json(500, { error: 'boom' })));

    const pending = expect(provider.generate(WRITE)).rejects.toThrow(
      'Ollama generate call to gemma4:e4b-mlx failed: Ollama returned 500 for /api/chat: boom',
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(calls).toHaveLength(3);
  });

  it('honors a configured retry count', async () => {
    const { provider, calls } = setup(
      sequence(() => json(500, { error: 'boom' })),
      {
        retries: 0,
      },
    );
    await expect(provider.generate(WRITE)).rejects.toThrow(DigestError);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a 400 and reports Ollama’s error', async () => {
    const { provider, calls, lines } = setup(
      sequence(() => json(400, { error: 'question "a": criteria must contain 2–255 candidates' })),
    );

    await expect(provider.decide(DECIDE)).rejects.toThrow(
      'Ollama returned 400 for /v1/systemone: question "a": criteria must contain 2–255 candidates',
    );
    expect(calls).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({ level: 'error', fields: { op: 'decide', attempts: 1 } });
  });

  it('suggests pulling the model on 404', async () => {
    const { provider } = setup(
      sequence(() => json(404, { error: "model 'gemma4:e4b-mlx' not found" })),
    );
    await expect(provider.generate(WRITE)).rejects.toThrow(
      "Ollama returned 404 for /api/chat: model 'gemma4:e4b-mlx' not found. Pull it with `ollama pull gemma4:e4b-mlx` and check that Ollama is up to date.",
    );
  });

  it('reports a plain-text error body', async () => {
    const { provider } = setup(
      sequence(() => new Response('bad gateway', { status: 502 })),
      {
        retries: 0,
      },
    );
    await expect(provider.generate(WRITE)).rejects.toThrow(
      'Ollama returned 502 for /api/chat: bad gateway',
    );
  });

  it('fires the per-role timeout from config', async () => {
    const { provider, calls } = setup((call) => hang(call.signal), {
      retries: 0,
      timeoutsMs: { write: 5_000 },
    });
    let settled = false;
    const pending = provider.generate(WRITE).finally(() => {
      settled = true;
    });
    const assertion = expect(pending).rejects.toThrow(
      'Ollama generate call to gemma4:e4b-mlx (role write) timed out after 5000 ms',
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it('uses the spec default timeout per role', async () => {
    expect(DEFAULT_TIMEOUTS_MS).toEqual({
      classify: 60_000,
      guardPolicy: 60_000,
      guardRisk: 120_000,
      judge: 120_000,
      write: 600_000,
    });
    const { provider } = setup((call) => hang(call.signal), { retries: 0 });
    let settled = false;
    const pending = provider.decide(DECIDE).finally(() => {
      settled = true;
    });
    const assertion = expect(pending).rejects.toThrow('timed out after 60000 ms');

    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('retries a timed-out call', async () => {
    const { provider, calls } = setup(
      (call, index) => (index === 0 ? hang(call.signal) : chatOk()),
      { timeoutsMs: { write: 5_000 } },
    );

    const pending = provider.generate(WRITE);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ usage: { inputTokens: 42 } });
    expect(calls).toHaveLength(2);
  });

  it('retries a refused connection, then fails with the clear message', async () => {
    const { provider, calls } = setup(refused);

    const pending = expect(provider.generate(WRITE)).rejects.toThrow(UNREACHABLE);
    await vi.runAllTimersAsync();
    await pending;

    expect(calls).toHaveLength(3);
  });

  it('throws a DigestError when Ollama is not reachable', async () => {
    const { provider } = setup(refused, { retries: 0, baseUrl: `${BASE_URL}/` });
    const error = await provider.decide(DECIDE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DigestError);
    expect((error as DigestError).message).toBe(UNREACHABLE);
  });

  it('retries a reset connection and reports it when retries run out', async () => {
    const reset = (): never => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      });
    };
    const { provider, calls } = setup(reset, { retries: 1 });

    const pending = expect(provider.generate(WRITE)).rejects.toThrow(
      'Ollama generate call to gemma4:e4b-mlx failed: Ollama request to /api/chat failed: fetch failed: socket hang up (ECONNRESET)',
    );
    await vi.runAllTimersAsync();
    await pending;
    expect(calls).toHaveLength(2);
  });

  it('does not retry when the caller aborts', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    controller.abort(reason);
    const { provider, calls } = setup((call) => hang(call.signal));

    await expect(provider.generate({ ...WRITE, signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
  });

  it('stops at once when the caller aborts mid-request', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    const { provider, calls, lines } = setup((call) => hang(call.signal));

    const pending = expect(provider.generate({ ...WRITE, signal: controller.signal })).rejects.toBe(
      reason,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(reason);
    await pending;

    expect(calls).toHaveLength(1);
    expect(lines.at(-1)).toMatchObject({ level: 'warn', message: 'ollama call aborted' });
  });

  it('retries an error reported inside the stream', async () => {
    const { provider, calls } = setup(
      sequence(() => ndjson({ error: 'model runner has unexpectedly stopped' }), chatOk),
    );

    const pending = provider.generate(WRITE);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ usage: { outputTokens: 9 } });
    expect(calls).toHaveLength(2);
  });

  it('retries a body that breaks off mid-stream', async () => {
    const broken = (): Response =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"message":'));
            controller.error(new TypeError('terminated'));
          },
        }),
      );
    const { provider, calls } = setup(sequence(broken, chatOk));

    const pending = provider.generate(WRITE);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ usage: { inputTokens: 42 } });
    expect(calls).toHaveLength(2);
  });
});

describe('health', () => {
  function healthy(call: Call): Response {
    if (call.url.endsWith('/api/version')) return json(200, fixture('version.json'));
    return json(200, fixture('tags.json'));
  }

  it('maps the version and each model’s capabilities', async () => {
    const { provider, calls } = setup(healthy);

    const health = await provider.health();

    expect(health).toEqual({
      reachable: true,
      version: '0.40.4',
      models: [
        { name: 'clef:latest', capabilities: ['decision', 'vision'] },
        {
          name: 'gemma4:e4b-mlx',
          capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'],
        },
        { name: 'strands-decider:2b-mlx-bf16', capabilities: ['decision'] },
      ],
    });
    expect(calls.map((c) => [c.method, c.url]).sort()).toEqual([
      ['GET', `${BASE_URL}/api/tags`],
      ['GET', `${BASE_URL}/api/version`],
    ]);
  });

  it('gives a model without capabilities an empty list', async () => {
    const { provider } = setup((call) =>
      call.url.endsWith('/api/version')
        ? json(200, { version: '0.30.0' })
        : json(200, { models: [{ name: 'old:latest' }] }),
    );
    const health = await provider.health();
    expect(health.models).toEqual([{ name: 'old:latest', capabilities: [] }]);
  });

  it('reports unreachable Ollama without throwing', async () => {
    const { provider } = setup(refused);
    await expect(provider.health()).resolves.toEqual({
      reachable: false,
      models: [],
      error: UNREACHABLE,
    });
  });

  it('reports a failed model list while Ollama itself answers', async () => {
    const { provider } = setup((call) =>
      call.url.endsWith('/api/version')
        ? json(200, { version: '0.40.4' })
        : json(500, { error: 'disk read failed' }),
    );
    await expect(provider.health()).resolves.toEqual({
      reachable: true,
      version: '0.40.4',
      models: [],
      error: 'Ollama returned 500 for /api/tags: disk read failed',
    });
  });

  it('reports an unexpected version payload', async () => {
    const { provider } = setup((call) =>
      call.url.endsWith('/api/version') ? json(200, { v: 1 }) : json(200, { models: [] }),
    );
    const health = await provider.health();
    expect(health.reachable).toBe(false);
    expect(health.error).toMatch(/unexpected \/api\/version response/);
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports a hung Ollama after the health timeout', async () => {
      const { provider } = setup((call) => hang(call.signal));
      const pending = provider.health();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toEqual({
        reachable: false,
        models: [],
        error: `Ollama at ${BASE_URL} did not answer within 5000 ms`,
      });
    });
  });
});
