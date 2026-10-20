// HTTP transport for the Ollama adapter: JSON and NDJSON over the injected fetch, typed errors,
// and the mapping from transport errors to the DigestError messages users see.
import { z } from 'zod';
import { DigestError, errorMessage } from '../../shared/errors';
import { TimeoutError } from '../../shared/retry';
import { hasHttpScheme, parseEndpoint } from './endpoint';

/** Error codes meaning nothing listens at the Ollama URL. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);
const MAX_DETAIL_CHARS = 300;
const MAX_CAUSE_DEPTH = 5;
const NOT_FOUND = 404;
const FIRST_REDIRECT = 300;
const FIRST_CLIENT_ERROR = 400;
const FIRST_SERVER_ERROR = 500;

/** Ollama answered with a non-2xx status. */
export class OllamaHttpError extends Error {
  readonly status: number;

  constructor(path: string, status: number, detail: string) {
    super(`Ollama returned ${status} for ${path}: ${detail}`);
    this.name = 'OllamaHttpError';
    this.status = status;
  }
}

/** Ollama reported an error inside a 200 stream (for example, the model runner stopped). */
export class OllamaStreamError extends Error {
  constructor(path: string, detail: string) {
    super(`Ollama stream for ${path} failed: ${detail}`);
    this.name = 'OllamaStreamError';
  }
}

function causeChain(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && chain.length < MAX_CAUSE_DEPTH;) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function errorCode(error: unknown): string | undefined {
  const codes = causeChain(error).map((e) => (e as { code?: unknown }).code);
  return codes.find((code): code is string => typeof code === 'string');
}

/** "fetch failed" alone says little; add the innermost cause and its code. */
function describeNetworkCause(error: unknown, code: string | undefined): string {
  const root = causeChain(error).at(-1);
  const detail =
    root && root !== error ? `${errorMessage(error)}: ${root.message}` : errorMessage(error);
  return code && !detail.includes(code) ? `${detail} (${code})` : detail;
}

/**
 * The request or its body failed below HTTP (refused, reset, DNS failure, socket closed). `url` is
 * the request URL as it may be shown: the configured address, no credentials, then the path.
 */
export class OllamaNetworkError extends Error {
  readonly code: string | undefined;

  constructor(url: string, cause: unknown) {
    const code = errorCode(cause);
    super(`Ollama request to ${url} failed: ${describeNetworkCause(cause, code)}`, { cause });
    this.name = 'OllamaNetworkError';
    this.code = code;
  }

  get unreachable(): boolean {
    return this.code !== undefined && UNREACHABLE_CODES.has(this.code);
  }
}

export interface OllamaHttp {
  readonly baseUrl: string;
  get(path: string, signal: AbortSignal): Promise<unknown>;
  post(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  /** POST answered with NDJSON (Ollama streaming); resolves with every parsed line. */
  postStream(path: string, body: unknown, signal: AbortSignal): Promise<unknown[]>;
}

function errorField(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('error' in value)) return undefined;
  return typeof value.error === 'string' ? value.error : undefined;
}

function errorDetail(text: string, statusText: string): string {
  try {
    const detail = errorField(JSON.parse(text));
    if (detail !== undefined) return detail;
  } catch {
    // Not JSON: Ollama and proxies may answer errors in plain text.
  }
  return (text.trim() || statusText).slice(0, MAX_DETAIL_CHARS);
}

function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DigestError(
      `Ollama returned a non-JSON ${path} response: ${text.slice(0, MAX_DETAIL_CHARS)}`,
    );
  }
}

function parseNdjson(text: string, path: string): unknown[] {
  const lines = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => parseJson(line, path));
  const failure = lines.map(errorField).find((detail) => detail !== undefined);
  if (failure !== undefined) throw new OllamaStreamError(path, failure);
  return lines;
}

type SendInit = RequestInit & { signal: AbortSignal };

/** Runs a fetch step, turning a failure that is not our own abort into OllamaNetworkError. */
async function network<T>(url: string, signal: AbortSignal, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new OllamaNetworkError(url, error);
  }
}

function isRedirect(status: number): boolean {
  return status >= FIRST_REDIRECT && status < FIRST_CLIENT_ERROR;
}

/** Where a redirect points, as it may be shown: scheme, host and path only. Empty when unusable. */
function redirectTarget(response: Response, url: string): string {
  const location = response.headers.get('location');
  if (location === null || !URL.canParse(location, url)) return '';
  const target = new URL(location, url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return '';
  return ` to ${target.protocol}//${target.host}${target.pathname}`;
}

/**
 * Not followed: a redirect would send the prompts, which carry collected feed text, to a host the
 * user never configured (security invariant 4).
 */
function redirectError(root: string, path: string, response: Response): DigestError {
  const target = redirectTarget(response, `${root}${path}`);
  return new DigestError(
    `Ollama at ${root} answered ${path} with a redirect (HTTP ${response.status.toString()}${target}). ` +
      'Redirects are not followed, so a prompt never goes to another host: set OLLAMA_URL in .env to the final address.',
  );
}

function schemeError(root: string): DigestError {
  return new DigestError(
    `OLLAMA_URL must start with http:// or https://, but it is "${root.slice(0, MAX_DETAIL_CHARS)}". ` +
      'Set it in .env, for example OLLAMA_URL=http://localhost:11434.',
  );
}

/**
 * The client for one Ollama address. Credentials in the address become a Basic authorization
 * header (what the official client does), so no request URL or error message can carry them.
 */
export function createOllamaHttp(baseUrl: string, fetchFn: typeof fetch): OllamaHttp {
  const { root, authorization } = parseEndpoint(baseUrl);
  const authHeaders: Record<string, string> = authorization ? { authorization } : {};

  async function send(path: string, init: SendInit): Promise<string> {
    // Retrying cannot fix an address that is not HTTP, so this is not an OllamaNetworkError.
    if (!hasHttpScheme(root)) throw schemeError(root);
    const url = `${root}${path}`;
    const response = await network(url, init.signal, () =>
      fetchFn(url, { ...init, redirect: 'manual' }),
    );
    if (isRedirect(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw redirectError(root, path, response);
    }
    const text = await network(url, init.signal, () => response.text());
    if (!response.ok)
      throw new OllamaHttpError(path, response.status, errorDetail(text, response.statusText));
    return text;
  }

  const getInit = (signal: AbortSignal): SendInit => ({
    method: 'GET',
    headers: authHeaders,
    signal,
  });

  const postInit = (body: unknown, signal: AbortSignal): SendInit => ({
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  return {
    baseUrl: root,
    get: async (path, signal) => parseJson(await send(path, getInit(signal)), path),
    post: async (path, body, signal) => parseJson(await send(path, postInit(body, signal)), path),
    postStream: async (path, body, signal) =>
      parseNdjson(await send(path, postInit(body, signal)), path),
  };
}

/** Network errors, timeouts, stream errors and 5xx are worth another attempt; 4xx are not. */
export function isRetryable(error: unknown): boolean {
  if (
    error instanceof TimeoutError ||
    error instanceof OllamaNetworkError ||
    error instanceof OllamaStreamError
  )
    return true;
  return error instanceof OllamaHttpError && error.status >= FIRST_SERVER_ERROR;
}

export function unreachableMessage(baseUrl: string): string {
  return `Ollama is not reachable at ${baseUrl}. Start the Ollama app or run \`ollama serve\`.`;
}

export interface CallContext {
  baseUrl: string;
  op: string;
  role: string;
  model: string;
  timeoutMs: number;
}

/** The DigestError for a model call that failed after its retries. */
export function toDigestError(error: unknown, context: CallContext): DigestError {
  if (error instanceof DigestError) return error;
  const { baseUrl, op, role, model, timeoutMs } = context;
  if (error instanceof OllamaNetworkError && error.unreachable)
    return new DigestError(unreachableMessage(baseUrl), { cause: error });
  if (error instanceof TimeoutError)
    return new DigestError(
      `Ollama ${op} call to ${model} (role ${role}) timed out after ${timeoutMs} ms`,
      { cause: error },
    );
  const hint =
    error instanceof OllamaHttpError && error.status === NOT_FOUND
      ? `. Pull it with \`ollama pull ${model}\` and check that Ollama is up to date.`
      : '';
  return new DigestError(`Ollama ${op} call to ${model} failed: ${errorMessage(error)}${hint}`, {
    cause: error,
  });
}

/** Parses an Ollama payload with `schema`, or throws a DigestError naming the endpoint. */
export function parseOllamaResponse<T>(schema: z.ZodType<T>, raw: unknown, path: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new DigestError(
      `Ollama returned an unexpected ${path} response: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}
