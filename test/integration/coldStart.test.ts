// A model that is not loaded yet answers its first call late. The real Ollama adapter must not
// spend a timeout and a retry on that: 2026-10-19, `quality`, the first `guardPolicy` call to clef
// timed out at 60 s while the model loaded, then took 47 s again (107 s in all).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOllamaProvider } from '../../src/models/adapters/ollama';
import type { GenerateRequest } from '../../src/models/ModelProvider';
import { chatReply, fakeOllama, type FakeOllama, type OllamaCall } from './fakeOllama';
import { FIRST_WRITER, OLLAMA_URL, PROFILE, SECOND_WRITER } from './harness/constants';
import { recordingLogger, type LogLine } from './harness/recordingLogger';

const WRITE_TIMEOUT_MS = 60_000;
const LOAD_MS = 90_000;
const COLD_START_MS = 120_000;

const ask = (model: string): GenerateRequest => ({
  role: 'write',
  model,
  system: 'You write digests.',
  prompt: 'Summarize.',
});

/** An Ollama whose model needs `loadMs` for its first answer; later answers are immediate. */
function slowToLoad(loadMs: number, ollama: { calls: () => readonly OllamaCall[] }) {
  return (call: OllamaCall): Promise<Response> => {
    const first = ollama.calls().filter((c) => c.model === call.model).length === 1;
    if (!first) return Promise.resolve(chatReply('{}'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(chatReply('{}'));
      }, loadMs);
      call.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(call.signal.reason as Error);
      });
    });
  };
}

function setup(loadMs: number, coldStartMs: number) {
  const { logger, lines } = recordingLogger();
  const holder: { ollama?: FakeOllama } = {};
  const ollama = fakeOllama({
    chat: slowToLoad(loadMs, { calls: () => holder.ollama?.calls ?? [] }),
  });
  holder.ollama = ollama;
  const provider = createOllamaProvider({
    baseUrl: OLLAMA_URL,
    profile: PROFILE,
    fetch: ollama.fetch,
    timeoutsMs: { write: WRITE_TIMEOUT_MS },
    coldStartMs,
    logger,
  });
  return { provider, ollama, lines };
}

const chats = (ollama: FakeOllama) => ollama.calls.filter((call) => call.path === '/api/chat');
const callLine = (lines: LogLine[], nth: number): LogLine | undefined =>
  lines.filter((line) => line.message === 'ollama call')[nth];

describe('integration: a model that loads on its first call', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers a load longer than the role timeout in one attempt, with no retry', async () => {
    const { provider, ollama, lines } = setup(LOAD_MS, COLD_START_MS);

    const pending = provider.generate(ask(FIRST_WRITER));
    await vi.advanceTimersByTimeAsync(LOAD_MS);
    await pending;

    expect(chats(ollama)).toHaveLength(1);
    expect(lines.some((line) => line.message === 'ollama call failed, retrying')).toBe(false);
    expect(callLine(lines, 0)?.fields).toMatchObject({
      model: FIRST_WRITER,
      attempts: 1,
      coldStart: true,
    });
  });

  it('burns a timeout and a retry on the same load without the allowance (the old behaviour)', async () => {
    const { provider, ollama, lines } = setup(LOAD_MS, 0);

    const pending = provider.generate(ask(FIRST_WRITER));
    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS + 1_000);
    await pending;

    expect(chats(ollama).map((call) => call.nth)).toEqual([1, 2]);
    expect(lines.some((line) => line.message === 'ollama call failed, retrying')).toBe(true);
  });

  it('asks again with the plain timeout once the model is loaded', async () => {
    const { provider, ollama } = setup(LOAD_MS, COLD_START_MS);
    const first = provider.generate(ask(FIRST_WRITER));
    await vi.advanceTimersByTimeAsync(LOAD_MS);
    await first;

    const second = provider.generate(ask(FIRST_WRITER));
    await vi.advanceTimersByTimeAsync(0);
    await second;

    expect(chats(ollama).map((call) => [call.model, call.nth])).toEqual([
      [FIRST_WRITER, 1],
      [FIRST_WRITER, 2],
    ]);
  });

  it('treats the other writer as cold: the panel swaps models, so it loads again', async () => {
    const { provider, ollama, lines } = setup(LOAD_MS, COLD_START_MS);
    const first = provider.generate(ask(FIRST_WRITER));
    await vi.advanceTimersByTimeAsync(LOAD_MS);
    await first;

    const second = provider.generate(ask(SECOND_WRITER));
    await vi.advanceTimersByTimeAsync(LOAD_MS);
    await second;

    expect(chats(ollama).map((call) => [call.model, call.nth])).toEqual([
      [FIRST_WRITER, 1],
      [SECOND_WRITER, 1],
    ]);
    expect(callLine(lines, 1)?.fields).toMatchObject({ model: SECOND_WRITER, coldStart: true });
  });

  it('still gives up on a load that takes too long: after the role timeout plus the allowance', async () => {
    const { provider, ollama } = setup(10 * COLD_START_MS, COLD_START_MS);
    const pending = provider.generate(ask(FIRST_WRITER));

    await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS + COLD_START_MS - 1);
    expect(chats(ollama)[0]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(chats(ollama)[0]?.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;

    expect(chats(ollama).map((call) => call.nth)).toEqual([1, 2]);
  });
});
