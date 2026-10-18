// A scripted Ollama for the real createOllamaProvider: the injected `fetch` answers /api/version
// and /api/tags itself and hands /api/chat and /v1/systemone to the test, so a test decides which
// call hangs, fails or answers. Nothing here opens a socket.
import { z } from 'zod';
import { PROFILES, requiredModels } from '../../src/config/profiles';

export interface OllamaCall {
  readonly path: string;
  /** The `model` field of the request body, when it has one. */
  readonly model: string | undefined;
  /** The user message of a /api/chat request; empty for every other call. */
  readonly prompt: string;
  /** 1 for the first call to this path and model, 2 for the next (a retry or a repair), and so on. */
  readonly nth: number;
  readonly signal: AbortSignal;
}

export type OllamaRoute = (call: OllamaCall) => Response | Promise<Response>;

export interface FakeOllamaOptions {
  /** Tags /api/tags lists. Default: every model of the quality profile. */
  models?: readonly string[];
  chat?: OllamaRoute;
  systemone?: OllamaRoute;
  /** Replaces the whole server, for an Ollama that is down. */
  down?: Error;
}

export interface FakeOllama {
  readonly fetch: typeof fetch;
  readonly calls: readonly OllamaCall[];
}

const CHAT = '/api/chat';
const SYSTEMONE = '/v1/systemone';
const VERSION = '/api/version';
const TAGS = '/api/tags';
const NOT_IMPLEMENTED = 501;

const RequestBodySchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).optional(),
});

function parseBody(body: RequestInit['body']): { model: string | undefined; prompt: string } {
  if (typeof body !== 'string') return { model: undefined, prompt: '' };
  const parsed = RequestBodySchema.parse(JSON.parse(body));
  const user = parsed.messages?.find((message) => message.role === 'user');
  return { model: parsed.model, prompt: user?.content ?? '' };
}

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input);
  return input instanceof URL ? input : new URL(input.url);
}

/** What Ollama answers to a streamed /api/chat: NDJSON, a content line, then the done line. */
export function chatReply(text: string): Response {
  const lines = [
    { message: { content: text }, done: false },
    { done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 20 },
  ];
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n'));
}

/** A call that never answers: it ends only when the adapter's timeout aborts it. */
export function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** What a fetch to a closed port rejects with, as Node reports it. */
export function connectionRefused(): Error {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
    code: 'ECONNREFUSED',
  });
  return new TypeError('fetch failed', { cause });
}

export function fakeOllama(options: FakeOllamaOptions = {}): FakeOllama {
  const models = options.models ?? requiredModels(PROFILES.quality);
  const calls: OllamaCall[] = [];
  const counts = new Map<string, number>();

  const handle = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const path = urlOf(input).pathname;
    const { model, prompt } = parseBody(init?.body);
    const key = `${path} ${model ?? ''}`;
    const nth = (counts.get(key) ?? 0) + 1;
    counts.set(key, nth);
    const signal = init?.signal ?? new AbortController().signal;
    const call: OllamaCall = { path, model, prompt, nth, signal };
    calls.push(call);
    if (options.down) throw options.down;
    if (path === VERSION) return Response.json({ version: '0.40.4' });
    if (path === TAGS) {
      return Response.json({
        models: models.map((name) => ({ name, capabilities: ['completion'] })),
      });
    }
    const route = path === CHAT ? options.chat : path === SYSTEMONE ? options.systemone : undefined;
    return (await route?.(call)) ?? new Response('not scripted', { status: NOT_IMPLEMENTED });
  };
  return { fetch: handle, calls };
}
