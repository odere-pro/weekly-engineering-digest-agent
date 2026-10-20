import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DigestError } from '../../../shared/errors';
import type { Usage } from '../../ModelProvider';
import {
  BASE_URL,
  chatOk,
  fakeContext,
  hang,
  json,
  ndjson,
  refused,
  sequence,
  UNREACHABLE,
  type FakeContext,
} from '../__fixtures__/ollamaHarness';
import { callOllama, DEFAULT_COLD_START_MS, DEFAULT_TIMEOUTS_MS } from './callOllama';

const CHAT_PATH = '/api/chat';
const SYSTEMONE_PATH = '/v1/systemone';
const WRITER = 'gemma4:e4b-mlx';
const DECIDER = 'strands-decider:2b-mlx-bf16';

/** Reads the counts off the last streamed chat line, as the chat parser does. */
function parseCounts(raw: unknown): { usage: Usage } {
  const last = (raw as { prompt_eval_count?: number; eval_count?: number }[]).at(-1);
  return {
    usage: { inputTokens: last?.prompt_eval_count ?? 0, outputTokens: last?.eval_count ?? 0 },
  };
}

/** A streamed chat call of role write, the shape `generate` sends. */
function callWrite(
  fake: FakeContext,
  signal?: AbortSignal,
  logFields?: Record<string, unknown>,
): Promise<{ usage: Usage; latencyMs: number }> {
  return callOllama(
    fake.context,
    {
      op: 'generate',
      role: 'write',
      model: WRITER,
      signal,
      ...(logFields === undefined ? {} : { logFields }),
      send: (attemptSignal) => fake.http.postStream(CHAT_PATH, {}, attemptSignal),
    },
    parseCounts,
  );
}

/** A decision call of role classify, the shape `decide` sends. */
function callDecide(fake: FakeContext): Promise<{ usage: Usage; latencyMs: number }> {
  return callOllama(
    fake.context,
    {
      op: 'decide',
      role: 'classify',
      model: DECIDER,
      signal: undefined,
      send: (attemptSignal) => fake.http.post(SYSTEMONE_PATH, {}, attemptSignal),
    },
    () => ({ usage: { inputTokens: 0, outputTokens: 0 } }),
  );
}

describe('callOllama', () => {
  it('returns the parsed value with its latency', async () => {
    const fake = fakeContext(sequence(chatOk));

    const result = await callWrite(fake);

    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 9 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fake.calls).toHaveLength(1);
  });

  it('logs one line per call with role, model, op, latency, attempts and tokens', async () => {
    const fake = fakeContext(sequence(chatOk));

    await callWrite(fake);

    expect(fake.lines).toHaveLength(1);
    expect(fake.lines[0]).toMatchObject({
      level: 'info',
      message: 'ollama call',
      fields: {
        role: 'write',
        model: WRITER,
        op: 'generate',
        attempts: 1,
        inputTokens: 42,
        outputTokens: 9,
      },
    });
    expect(fake.lines[0]!.fields.latencyMs).toEqual(expect.any(Number));
  });

  it('adds the spec’s log fields to every line it writes', async () => {
    const ok = fakeContext(sequence(chatOk));
    await callWrite(ok, undefined, { think: 'high' });
    expect(ok.lines[0]!.fields).toMatchObject({ think: 'high' });

    const failing = fakeContext(
      sequence(() => json(400, { error: 'bad request' })),
      { retries: 0 },
    );
    await expect(callWrite(failing, undefined, { think: 'high' })).rejects.toThrow(DigestError);
    expect(failing.lines.at(-1)).toMatchObject({ level: 'error', fields: { think: 'high' } });
  });

  it('does not retry a payload the parser rejects, and keeps its DigestError', async () => {
    const fake = fakeContext(sequence(chatOk));
    const rejected = new DigestError('the payload is wrong');

    await expect(
      callOllama(
        fake.context,
        {
          op: 'generate',
          role: 'write',
          model: WRITER,
          signal: undefined,
          send: (signal) => fake.http.postStream(CHAT_PATH, {}, signal),
        },
        () => {
          throw rejected;
        },
      ),
    ).rejects.toBe(rejected);

    expect(fake.calls).toHaveLength(1);
    expect(fake.lines.at(-1)).toMatchObject({ level: 'error', message: 'ollama call failed' });
  });
});

describe('callOllama reliability', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a 503 and then succeeds', async () => {
    const fake = fakeContext(sequence(() => json(503, { error: 'server busy' }), chatOk));

    const pending = callWrite(fake);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.usage.inputTokens).toBe(42);
    expect(fake.calls).toHaveLength(2);
    expect(fake.lines.find((l) => l.level === 'warn')).toMatchObject({
      message: 'ollama call failed, retrying',
      fields: { attempt: 1, error: expect.stringContaining('server busy') as unknown },
    });
    expect(fake.lines.at(-1)).toMatchObject({ level: 'info', fields: { attempts: 2 } });
  });

  it('gives up after two retries on 5xx', async () => {
    const fake = fakeContext(sequence(() => json(500, { error: 'boom' })));

    const pending = expect(callWrite(fake)).rejects.toThrow(
      'Ollama generate call to gemma4:e4b-mlx failed: Ollama returned 500 for /api/chat: boom',
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(fake.calls).toHaveLength(3);
  });

  it('honors a configured retry count', async () => {
    const fake = fakeContext(
      sequence(() => json(500, { error: 'boom' })),
      { retries: 0 },
    );
    await expect(callWrite(fake)).rejects.toThrow(DigestError);
    expect(fake.calls).toHaveLength(1);
  });

  it('backs off 1 s, 2 s, 4 s and so on, and caps the wait at 10 s', async () => {
    const fake = fakeContext(
      sequence(() => json(503, { error: 'busy' })),
      { retries: 5 },
    );
    const pending = expect(callWrite(fake)).rejects.toThrow(DigestError);
    const callsAfter = async (ms: number): Promise<number> => {
      await vi.advanceTimersByTimeAsync(ms);
      return fake.calls.length;
    };

    expect(await callsAfter(0)).toBe(1);
    expect(await callsAfter(999)).toBe(1);
    expect(await callsAfter(1)).toBe(2); // 1 s
    expect(await callsAfter(1_999)).toBe(2);
    expect(await callsAfter(1)).toBe(3); // 2 s
    expect(await callsAfter(3_999)).toBe(3);
    expect(await callsAfter(1)).toBe(4); // 4 s
    expect(await callsAfter(7_999)).toBe(4);
    expect(await callsAfter(1)).toBe(5); // 8 s
    expect(await callsAfter(9_999)).toBe(5);
    expect(await callsAfter(1)).toBe(6); // 16 s, capped at 10 s
    await pending;
  });

  it('starts the backoff from retryBaseDelayMs when the options set one', async () => {
    const fake = fakeContext(
      sequence(() => json(503, { error: 'busy' })),
      { retries: 3, retryBaseDelayMs: 10 },
    );
    const pending = expect(callWrite(fake)).rejects.toThrow(DigestError);
    const callsAfter = async (ms: number): Promise<number> => {
      await vi.advanceTimersByTimeAsync(ms);
      return fake.calls.length;
    };

    expect(await callsAfter(9)).toBe(1);
    expect(await callsAfter(1)).toBe(2); // 10 ms
    expect(await callsAfter(19)).toBe(2);
    expect(await callsAfter(1)).toBe(3); // 20 ms
    expect(await callsAfter(39)).toBe(3);
    expect(await callsAfter(1)).toBe(4); // 40 ms
    await pending;
  });

  it('does not retry a 400 and reports Ollama’s error', async () => {
    const fake = fakeContext(
      sequence(() => json(400, { error: 'question "a": criteria must contain 2–255 candidates' })),
    );

    await expect(callDecide(fake)).rejects.toThrow(
      'Ollama returned 400 for /v1/systemone: question "a": criteria must contain 2–255 candidates',
    );
    expect(fake.calls).toHaveLength(1);
    expect(fake.lines.at(-1)).toMatchObject({
      level: 'error',
      fields: { op: 'decide', attempts: 1 },
    });
  });

  it('suggests pulling the model on 404', async () => {
    const fake = fakeContext(
      sequence(() => json(404, { error: "model 'gemma4:e4b-mlx' not found" })),
    );
    await expect(callWrite(fake)).rejects.toThrow(
      "Ollama returned 404 for /api/chat: model 'gemma4:e4b-mlx' not found. Pull it with `ollama pull gemma4:e4b-mlx` and check that Ollama is up to date.",
    );
  });

  it('reports a plain-text error body', async () => {
    const fake = fakeContext(
      sequence(() => new Response('bad gateway', { status: 502 })),
      { retries: 0 },
    );
    await expect(callWrite(fake)).rejects.toThrow('Ollama returned 502 for /api/chat: bad gateway');
  });

  it('fires the per-role timeout from config', async () => {
    const fake = fakeContext((call) => hang(call.signal), {
      retries: 0,
      timeoutsMs: { write: 5_000 },
    });
    let settled = false;
    const pending = callWrite(fake).finally(() => {
      settled = true;
    });
    const assertion = expect(pending).rejects.toThrow(
      'Ollama generate call to gemma4:e4b-mlx (role write) timed out after 5000 ms',
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(fake.calls[0]!.signal?.aborted).toBe(true);
  });

  it('uses the spec default timeout per role', async () => {
    expect(DEFAULT_TIMEOUTS_MS).toEqual({
      classify: 60_000,
      guardPolicy: 60_000,
      guardRisk: 120_000,
      judge: 120_000,
      write: 600_000,
    });
    const fake = fakeContext((call) => hang(call.signal), { retries: 0 });
    let settled = false;
    const pending = callDecide(fake).finally(() => {
      settled = true;
    });
    const assertion = expect(pending).rejects.toThrow('timed out after 60000 ms');

    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });

  it('retries a timed-out call', async () => {
    const fake = fakeContext((call, index) => (index === 0 ? hang(call.signal) : chatOk()), {
      timeoutsMs: { write: 5_000 },
    });

    const pending = callWrite(fake);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ usage: { inputTokens: 42 } });
    expect(fake.calls).toHaveLength(2);
  });

  it('retries a refused connection, then fails with the clear message', async () => {
    const fake = fakeContext(refused);

    const pending = expect(callWrite(fake)).rejects.toThrow(UNREACHABLE);
    await vi.runAllTimersAsync();
    await pending;

    expect(fake.calls).toHaveLength(3);
  });

  it('throws a DigestError when Ollama is not reachable', async () => {
    const fake = fakeContext(refused, { retries: 0, baseUrl: `${BASE_URL}/` });
    const error = await callDecide(fake).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DigestError);
    expect((error as DigestError).message).toBe(UNREACHABLE);
  });

  it('retries a reset connection and reports it when retries run out', async () => {
    const reset = (): never => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      });
    };
    const fake = fakeContext(reset, { retries: 1 });

    const pending = expect(callWrite(fake)).rejects.toThrow(
      `Ollama generate call to gemma4:e4b-mlx failed: Ollama request to ${BASE_URL}/api/chat failed: fetch failed: socket hang up (ECONNRESET)`,
    );
    await vi.runAllTimersAsync();
    await pending;
    expect(fake.calls).toHaveLength(2);
  });

  it('does not retry when the caller aborts', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    controller.abort(reason);
    const fake = fakeContext((call) => hang(call.signal));

    await expect(callWrite(fake, controller.signal)).rejects.toBe(reason);
    expect(fake.calls).toHaveLength(1);
  });

  it('does not retry a 503 once the caller has aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    const fake = fakeContext(sequence(() => json(503, { error: 'busy' }), chatOk));

    await expect(callWrite(fake, controller.signal)).rejects.toThrow('Ollama returned 503');
    expect(fake.calls).toHaveLength(1);
    expect(fake.lines.at(-1)).toMatchObject({ level: 'warn', message: 'ollama call aborted' });
  });

  it('stops at once when the caller aborts mid-request', async () => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    const fake = fakeContext((call) => hang(call.signal));

    const pending = expect(callWrite(fake, controller.signal)).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(reason);
    await pending;

    expect(fake.calls).toHaveLength(1);
    expect(fake.lines.at(-1)).toMatchObject({ level: 'warn', message: 'ollama call aborted' });
  });

  it('retries an error reported inside the stream', async () => {
    const fake = fakeContext(
      sequence(() => ndjson({ error: 'model runner has unexpectedly stopped' }), chatOk),
    );

    const pending = callWrite(fake);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ usage: { outputTokens: 9 } });
    expect(fake.calls).toHaveLength(2);
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
    const fake = fakeContext(sequence(broken, chatOk));

    const pending = callWrite(fake);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ usage: { inputTokens: 42 } });
    expect(fake.calls).toHaveLength(2);
  });
});

describe('callOllama cold start', () => {
  const COLD_START_MS = 20_000;
  const OTHER = 'nemotron-3.5-lightning:30b-mlx';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A streamed chat call of role write to `model`. */
  const callModel = (fake: FakeContext, model: string) =>
    callOllama(
      fake.context,
      {
        op: 'generate',
        role: 'write',
        model,
        signal: undefined,
        send: (attemptSignal) => fake.http.postStream(CHAT_PATH, {}, attemptSignal),
      },
      parseCounts,
    );

  const coldContext = (handler: Parameters<typeof fakeContext>[0]): FakeContext =>
    fakeContext(handler, {
      retries: 0,
      timeoutsMs: { write: 5_000 },
      coldStartMs: COLD_START_MS,
    });

  it('has an allowance of 5 min by default, far above the slowest load measured (107 s)', () => {
    expect(DEFAULT_COLD_START_MS).toBe(300_000);
  });

  it('adds the allowance to the timeout of the first call to a model', async () => {
    const fake = coldContext((call) => hang(call.signal));
    const pending = expect(callModel(fake, WRITER)).rejects.toThrow(
      'Ollama generate call to gemma4:e4b-mlx (role write) timed out after 25000 ms',
    );

    await vi.advanceTimersByTimeAsync(24_999);
    expect(fake.calls[0]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fake.calls[0]!.signal?.aborted).toBe(true);
  });

  it('lets a slow first call finish where the plain timeout would have fired and retried', async () => {
    const fake = fakeContext(
      (call) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(chatOk());
          }, 12_000);
          call.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(call.signal?.reason as Error);
          });
        }),
      { timeoutsMs: { write: 5_000 }, coldStartMs: COLD_START_MS },
    );

    const pending = callModel(fake, WRITER);
    await vi.advanceTimersByTimeAsync(12_000);

    await expect(pending).resolves.toMatchObject({ usage: { inputTokens: 42 } });
    expect(fake.calls).toHaveLength(1);
    expect(fake.lines.find((line) => line.message === 'ollama call')?.fields).toMatchObject({
      attempts: 1,
      coldStart: true,
    });
  });

  it('gives the plain timeout to the next call to the model that answered', async () => {
    const fake = coldContext((call, index) => (index === 0 ? chatOk() : hang(call.signal)));
    await callModel(fake, WRITER);

    const pending = expect(callModel(fake, WRITER)).rejects.toThrow('timed out after 5000 ms');
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    const infos = fake.lines.filter((line) => line.message === 'ollama call');
    expect(infos[0]?.fields).toMatchObject({ coldStart: true });
    expect(infos).toHaveLength(1);
  });

  it('marks only the cold call in the log, and leaves coldStart off a warm one', async () => {
    const fake = coldContext(() => chatOk());

    await callModel(fake, WRITER);
    await callModel(fake, WRITER);

    const infos = fake.lines.filter((line) => line.message === 'ollama call');
    expect(infos.map((line) => line.fields.coldStart)).toEqual([true, undefined]);
  });

  it('calls the first model cold again once another model has answered', async () => {
    const fake = coldContext((call, index) => (index < 2 ? chatOk() : hang(call.signal)));
    await callModel(fake, WRITER);
    await callModel(fake, OTHER);

    const pending = expect(callModel(fake, WRITER)).rejects.toThrow('timed out after 25000 ms');
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;
  });

  it('keeps a model cold when its call failed: the load did not happen', async () => {
    const fake = coldContext((call, index) =>
      index === 0 ? json(404, { error: 'model not found' }) : hang(call.signal),
    );
    await expect(callModel(fake, WRITER)).rejects.toThrow('404');

    const pending = expect(callModel(fake, WRITER)).rejects.toThrow('timed out after 25000 ms');
    await vi.advanceTimersByTimeAsync(25_000);
    await pending;
  });

  it('gives a retry of a cold call the allowance too', async () => {
    const fake = fakeContext((call, index) => (index === 0 ? refused() : hang(call.signal)), {
      retries: 1,
      timeoutsMs: { write: 5_000 },
      coldStartMs: COLD_START_MS,
    });

    const pending = expect(callModel(fake, WRITER)).rejects.toThrow('timed out after 25000 ms');
    await vi.advanceTimersByTimeAsync(1_000 + 24_999);
    expect(fake.calls[1]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });

  it('turns the allowance off with 0', async () => {
    const fake = fakeContext((call) => hang(call.signal), {
      retries: 0,
      timeoutsMs: { write: 5_000 },
      coldStartMs: 0,
    });

    const pending = expect(callModel(fake, WRITER)).rejects.toThrow('timed out after 5000 ms');
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
  });
});
