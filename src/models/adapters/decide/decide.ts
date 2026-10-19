import type { DecideRequest, DecideResult } from '../../ModelProvider';
import { callOllama } from '../call/callOllama';
import { resolveModel } from '../call/resolveModel';
import type { CallSpec, OllamaContext } from '../call/types';
import { parseSystemOneResponse, toSystemOneQuestions, validateQuestions } from '../systemone';
import { fitState } from './fitState';

const SYSTEMONE_PATH = '/v1/systemone';

/**
 * One /v1/systemone call: the questions checked and mapped, the state fitted to the model's
 * context, the answers mapped back. `think` and the sampling options do not apply to it.
 */
export async function decide(
  context: OllamaContext,
  request: DecideRequest,
): Promise<DecideResult> {
  validateQuestions(request.questions);
  const model = resolveModel(context.options.profile, request.role);
  const questions = toSystemOneQuestions(request.questions);
  const body = {
    model,
    state: fitState(
      context.options.logger,
      { role: request.role, model },
      request.state,
      questions,
    ),
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
