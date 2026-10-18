import { z } from 'zod';
import { modelsForRole, type ModelProfile } from '../../config/profiles';
import type { Role } from '../roles';
import type {
  DecideRequest,
  DecideResult,
  GenerateRequest,
  GenerateResult,
  ModelHealth,
  ModelProvider,
  Usage,
} from '../ModelProvider';
import { DigestError, errorMessage } from '../../shared/errors';
import { TimeoutError, withRetry, withTimeout } from '../../shared/retry';
import type { LogFields, Logger } from '../../shared/telemetry';
import {
  createOllamaHttp,
  isRetryable,
  OllamaNetworkError,
  parseOllamaResponse,
  toDigestError,
  unreachableMessage,
  type OllamaHttp,
} from './ollamaHttp';
import {
  parseSystemOneResponse,
  questionSize,
  stateBudgetFor,
  toSystemOneQuestions,
  trimState,
  validateQuestions,
  type SystemOneQuestion,
} from './systemone';

/** Ollama's `think` request field: on or off, or an effort level for models that have levels. */
export type ThinkSetting = boolean | 'low' | 'medium' | 'high';
export type ThinkByRole = Readonly<Partial<Record<Role, ThinkSetting>>>;
export type TemperatureByRole = Readonly<Partial<Record<Role, number>>>;

export interface OllamaProviderOptions {
  baseUrl: string;
  profile: ModelProfile;
  timeoutsMs?: Partial<Record<Role, number>>;
  /**
   * Per-role `think` for generate (/api/chat); a role without a setting keeps the model's own
   * default. decide (/v1/systemone) ignores it.
   */
  think?: ThinkByRole;
  /**
   * Sampling seed sent with every generate call that carries none of its own (W7-03). Unset sends
   * no seed.
   */
  seed?: number;
  /** Per-role temperature overrides; a request's own temperature still wins. */
  temperature?: TemperatureByRole;
  /** Spec: 2 retries with backoff. */
  retries?: number;
  fetch?: typeof fetch;
  logger: Logger;
}

/** Per-role timeout for one attempt (spec defaults); `timeoutsMs` overrides them. */
export const DEFAULT_TIMEOUTS_MS: Readonly<Record<Role, number>> = {
  classify: 60_000,
  guardPolicy: 60_000,
  guardRisk: 120_000,
  judge: 120_000,
  write: 600_000,
};
/**
 * Per-role `think` when `options.think` has none. granite4.1-guardian is a thinking model that
 * spends ~350 tokens (~65 s) on reasoning before a one-word `<score>`; the guards do not need it.
 */
export const DEFAULT_THINK: ThinkByRole = { guardRisk: false };
/**
 * Per-role sampling temperature when neither the request nor the config sets one (W7-03): a little
 * warmth for the writer, none for the roles that score, classify or guard.
 */
export const DEFAULT_TEMPERATURE: Readonly<Record<Role, number>> = {
  write: 0.2,
  classify: 0,
  guardPolicy: 0,
  guardRisk: 0,
  judge: 0,
};
const DEFAULT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 10_000;
const HEALTH_TIMEOUT_MS = 5_000;

const CHAT_PATH = '/api/chat';
const SYSTEMONE_PATH = '/v1/systemone';
const VERSION_PATH = '/api/version';
const TAGS_PATH = '/api/tags';

/** One line of a streamed /api/chat reply; the last line has `done: true` and the counts. */
const ChatChunkSchema = z.object({
  message: z.object({ content: z.string() }).optional(),
  done: z.boolean(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().min(0).optional(),
  eval_count: z.number().int().min(0).optional(),
});
/** Ollama's done_reason when the reply hit the token limit. */
const LENGTH_DONE_REASON = 'length';
const VersionSchema = z.object({ version: z.string() });
const TagsSchema = z.object({
  models: z.array(z.object({ name: z.string(), capabilities: z.array(z.string()).optional() })),
});

interface Context {
  http: OllamaHttp;
  options: OllamaProviderOptions;
}

interface CallSpec {
  op: 'generate' | 'decide';
  role: Role;
  model: string;
  signal: AbortSignal | undefined;
  /** Extra fields for this call's log lines. */
  logFields?: LogFields;
  /** One attempt; `signal` combines the caller's signal and the attempt timeout. */
  send: (signal: AbortSignal) => Promise<unknown>;
}

/** ModelProvider on Ollama: /api/chat for generate, /v1/systemone for decide (W1-04). */
export function createOllamaProvider(options: OllamaProviderOptions): ModelProvider {
  const context: Context = {
    http: createOllamaHttp(options.baseUrl, options.fetch ?? globalThis.fetch),
    options,
  };
  return {
    generate: (request) => generate(context, request),
    decide: (request) => decide(context, request),
    health: () => health(context.http),
  };
}

function resolveModel(profile: ModelProfile, role: Role, explicit?: string): string {
  const model = explicit ?? modelsForRole(profile, role)[0];
  if (!model)
    throw new DigestError(`No model is configured for role ${role} in profile ${profile.name}`);
  return model;
}

/**
 * One model call: per-role timeout per attempt, retries with backoff on retryable errors,
 * `parse` on the payload, one log line. Failures become DigestErrors; caller aborts pass through.
 */
async function callOllama<T extends { usage: Usage }>(
  { http, options }: Context,
  spec: CallSpec,
  parse: (raw: unknown) => T,
): Promise<T & { latencyMs: number }> {
  const log = options.logger.child({ ...spec.logFields, role: spec.role, model: spec.model });
  const timeoutMs = options.timeoutsMs?.[spec.role] ?? DEFAULT_TIMEOUTS_MS[spec.role];
  const started = performance.now();
  let attempts = 0;
  try {
    const raw = await withRetry(
      (attempt) => {
        attempts = attempt + 1;
        return withTimeout(spec.send, timeoutMs, spec.signal);
      },
      {
        retries: options.retries ?? DEFAULT_RETRIES,
        baseDelayMs: RETRY_BASE_DELAY_MS,
        maxDelayMs: RETRY_MAX_DELAY_MS,
        shouldRetry: (error) => !spec.signal?.aborted && isRetryable(error),
        onRetry: (error, attempt) => {
          log.warn('ollama call failed, retrying', {
            op: spec.op,
            attempt: attempt + 1,
            error: errorMessage(error),
          });
        },
      },
    );
    const value = parse(raw);
    const latencyMs = Math.round(performance.now() - started);
    log.info('ollama call', { op: spec.op, latencyMs, attempts, ...value.usage });
    return { ...value, latencyMs };
  } catch (error) {
    const fields = { op: spec.op, latencyMs: Math.round(performance.now() - started), attempts };
    if (spec.signal?.aborted) {
      log.warn('ollama call aborted', fields);
      throw error;
    }
    log.error('ollama call failed', { ...fields, error: errorMessage(error) });
    throw toDigestError(error, { ...spec, baseUrl: http.baseUrl, timeoutMs });
  }
}

/**
 * The `think` value generate sends for `role`: the configured one, else the adapter default, else
 * undefined (the field is left out and the model decides). The one place that rule lives, so
 * `digest doctor` shows what a run sends.
 */
export function effectiveThink(
  configured: ThinkByRole | undefined,
  role: Role,
): ThinkSetting | undefined {
  return configured?.[role] ?? DEFAULT_THINK[role];
}

/**
 * The temperature generate sends for `role`: the configured one, else the adapter default. A
 * request's own temperature wins over both. The one place that rule lives, so the run record shows
 * what a run sends.
 */
export function effectiveTemperature(
  configured: TemperatureByRole | undefined,
  role: Role,
): number {
  return configured?.[role] ?? DEFAULT_TEMPERATURE[role];
}

function chatBody(
  model: string,
  request: GenerateRequest,
  think: ThinkSetting | undefined,
  sampling: { temperature: number; seed: number | undefined },
): Record<string, unknown> {
  const seed = request.seed ?? sampling.seed;
  const options = {
    temperature: request.temperature ?? sampling.temperature,
    ...(seed === undefined ? {} : { seed }),
  };
  return {
    model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ],
    // Streamed so headers arrive early: Node's fetch drops a response whose headers take
    // more than 300 s, which a non-streamed writer reply can exceed.
    stream: true,
    ...(think === undefined ? {} : { think }),
    ...(request.jsonSchema === undefined ? {} : { format: request.jsonSchema }),
    options,
  };
}

/** Joins streamed chat lines into the reply text, the counts and why it stopped. */
function joinChat(raw: unknown): { text: string; usage: Usage; doneReason: string | undefined } {
  const chunks = parseOllamaResponse(z.array(ChatChunkSchema), raw, CHAT_PATH);
  const last = chunks.at(-1);
  if (!last?.done)
    throw new DigestError(`Ollama ended the ${CHAT_PATH} stream before the reply was done`);
  return {
    text: chunks.map((chunk) => chunk.message?.content ?? '').join(''),
    usage: { inputTokens: last.prompt_eval_count ?? 0, outputTokens: last.eval_count ?? 0 },
    doneReason: last.done_reason,
  };
}

async function generate(context: Context, request: GenerateRequest): Promise<GenerateResult> {
  const model = resolveModel(context.options.profile, request.role, request.model);
  const think = effectiveThink(context.options.think, request.role);
  const body = chatBody(model, request, think, {
    temperature: effectiveTemperature(context.options.temperature, request.role),
    seed: context.options.seed,
  });
  const spec: CallSpec = {
    op: 'generate',
    role: request.role,
    model,
    signal: request.signal,
    logFields: { think: think ?? 'default' },
    send: (signal) => context.http.postStream(CHAT_PATH, body, signal),
  };
  const result = await callOllama(context, spec, joinChat);
  // A cut reply is returned as it is. With a schema it is an unfinished JSON document, which can
  // never validate, so generateStructured sends it to its one repair attempt; the line says why.
  if (result.doneReason === LENGTH_DONE_REASON)
    context.options.logger
      .child({ role: request.role, model, ...spec.logFields })
      .warn('ollama reply hit the token limit', {
        outputTokens: result.usage.outputTokens,
        structured: request.jsonSchema !== undefined,
      });
  return { model, text: result.text, usage: result.usage, latencyMs: result.latencyMs };
}

/** Trims `state` to what is left of the model's context after the questions. */
function fitState(
  context: Context,
  spec: { role: Role; model: string },
  state: string,
  questions: Readonly<Record<string, SystemOneQuestion>>,
): string {
  const questionChars = questionSize(questions);
  const trimmed = trimState(state, stateBudgetFor(spec.model, questionChars));
  if (trimmed !== state)
    context.options.logger.child(spec).warn('decide state trimmed', {
      fromChars: state.length,
      toChars: trimmed.length,
      questionChars,
    });
  return trimmed;
}

async function decide(context: Context, request: DecideRequest): Promise<DecideResult> {
  validateQuestions(request.questions);
  const model = resolveModel(context.options.profile, request.role);
  const questions = toSystemOneQuestions(request.questions);
  const body = {
    model,
    state: fitState(context, { role: request.role, model }, request.state, questions),
    questions,
  };
  const spec: CallSpec = {
    op: 'decide',
    role: request.role,
    model,
    signal: request.signal,
    send: (signal) => context.http.post(SYSTEMONE_PATH, body, signal),
  };
  const result = await callOllama(context, spec, (raw) =>
    parseSystemOneResponse(raw, request.questions),
  );
  return { model, answers: result.answers, usage: result.usage, latencyMs: result.latencyMs };
}

async function getParsed<T>(http: OllamaHttp, path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await withTimeout((signal) => http.get(path, signal), HEALTH_TIMEOUT_MS);
  return parseOllamaResponse(schema, raw, path);
}

function healthError(error: unknown, baseUrl: string): string {
  if (error instanceof OllamaNetworkError && error.unreachable) return unreachableMessage(baseUrl);
  if (error instanceof TimeoutError)
    return `Ollama at ${baseUrl} did not answer within ${HEALTH_TIMEOUT_MS} ms`;
  return errorMessage(error);
}

/** Version and installed models; never throws. */
async function health(http: OllamaHttp): Promise<ModelHealth> {
  const [version, tags] = await Promise.allSettled([
    getParsed(http, VERSION_PATH, VersionSchema),
    getParsed(http, TAGS_PATH, TagsSchema),
  ]);
  if (version.status === 'rejected')
    return { reachable: false, models: [], error: healthError(version.reason, http.baseUrl) };
  if (tags.status === 'rejected')
    return {
      reachable: true,
      version: version.value.version,
      models: [],
      error: healthError(tags.reason, http.baseUrl),
    };
  return {
    reachable: true,
    version: version.value.version,
    models: tags.value.models.map((m) => ({ name: m.name, capabilities: m.capabilities ?? [] })),
  };
}
