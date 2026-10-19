// Test kit for the Ollama adapter folders: a fake fetch that records every call, response builders,
// a recording logger, and a ready context. Not product code; coverage skips `__fixtures__/`.
import { readFileSync } from 'node:fs';
import { PROFILES } from '../../../config/profiles';
import type { LogFields, Logger } from '../../../shared/telemetry';
import type { DecideRequest, DecisionQuestion } from '../../ModelProvider';
import type { ChatOptions } from '../chat/generate';
import { createOllamaHttp, type OllamaHttp } from '../ollamaHttp';

export const BASE_URL = 'http://127.0.0.1:11434';
export const UNREACHABLE =
  'Ollama is not reachable at http://127.0.0.1:11434. Start the Ollama app or run `ollama serve`.';

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./ollama/${name}`, import.meta.url), 'utf8');
}

export function fixture(name: string): unknown {
  return JSON.parse(fixtureText(name)) as unknown;
}

export function ndjson(...lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n'), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function refused(): never {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
    code: 'ECONNREFUSED',
  });
  throw new TypeError('fetch failed', { cause });
}

/** A fetch that never answers; it rejects only when its signal aborts, like the real one. */
export function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(signal.reason as Error);
    signal?.addEventListener('abort', () => {
      reject(signal.reason as Error);
    });
  });
}

export interface Call {
  url: string;
  method: string;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

export type Handler = (call: Call, index: number) => Response | Promise<Response>;

export function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
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
export function sequence(...replies: (() => Response | Promise<Response>)[]): Handler {
  return (_call, index) => replies[Math.min(index, replies.length - 1)]!();
}

export interface Line {
  level: string;
  message: string;
  fields: LogFields;
}

export function recordingLogger(lines: Line[], base: LogFields = {}): Logger {
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

/** The options `createOllamaProvider` takes: what the calls read, the server and a `fetch`. */
export type TestOptions = ChatOptions & { baseUrl: string; fetch?: typeof fetch };

/** The `http` and `options` the call, chat and decide modules take, on top of a fake fetch. */
export interface FakeContext {
  context: { http: OllamaHttp; options: TestOptions };
  http: OllamaHttp;
  calls: Call[];
  lines: Line[];
}

export function fakeContext(handler: Handler, overrides: Partial<TestOptions> = {}): FakeContext {
  const fake = fakeFetch(handler);
  const lines: Line[] = [];
  const options: TestOptions = {
    baseUrl: BASE_URL,
    profile: PROFILES.light,
    fetch: fake.fetch,
    logger: recordingLogger(lines),
    ...overrides,
  };
  const http = createOllamaHttp(options.baseUrl, fake.fetch);
  return { context: { http, options }, http, calls: fake.calls, lines };
}

/** The recorded streamed chat reply: 42 prompt tokens, 9 output tokens. */
export const chatOk = (): Response =>
  new Response(fixtureText('chat-stream.ndjson'), {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });

export const WRITE = { role: 'write', system: 'You write digests.', prompt: 'Summarize.' } as const;

export const QUESTIONS = {
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

export const DECIDE: DecideRequest = {
  role: 'classify',
  state:
    'Release: vLLM v0.12.0 adds speculative decoding for Llama 4 and cuts p99 latency by 30% on H100.',
  questions: QUESTIONS,
};
