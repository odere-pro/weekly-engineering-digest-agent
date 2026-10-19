import type { GenerateRequest, GenerateResult } from '../../ModelProvider';
import { callOllama } from '../call/callOllama';
import { resolveModel } from '../call/resolveModel';
import type { CallOptions, CallSpec, OllamaContext } from '../call/types';
import { chatBody } from './chatBody';
import {
  effectiveTemperature,
  effectiveThink,
  type TemperatureByRole,
  type ThinkByRole,
} from './chatSettings';
import { CHAT_PATH, joinChat } from './chatStream';

/** The provider options `generate` reads, on top of what every call reads. */
export interface ChatOptions extends CallOptions {
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
}

export interface ChatContext extends OllamaContext {
  options: ChatOptions;
}

/** Ollama's done_reason when the reply hit the token limit. */
const LENGTH_DONE_REASON = 'length';

/** One streamed /api/chat call for the role's model (or the request's own). */
export async function generate(
  context: ChatContext,
  request: GenerateRequest,
): Promise<GenerateResult> {
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
