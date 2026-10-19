import type { Role } from '../models/roles';
import type { ModelProvider, Usage } from '../models/ModelProvider';
import { noopTracer, type Tracer } from '../shared/telemetry';
import { decorate, type MemberRules } from './decorate';

interface Measured {
  model: string;
  usage: Usage;
  latencyMs: number;
}

/**
 * One call inside a span named after its kind. The answer's model, latency and tokens go on a
 * `model.usage` span inside it, because `Tracer.span` fixes attributes when a span starts.
 */
async function measured<T extends Measured>(
  tracer: Tracer,
  kind: 'generate' | 'decide',
  role: Role,
  asked: string | undefined,
  call: () => Promise<T>,
): Promise<T> {
  const attributes = asked === undefined ? { role } : { role, model: asked };
  return tracer.span(`model.${kind}`, attributes, async () => {
    const result = await call();
    const { usage, latencyMs } = result;
    const used = {
      role,
      model: result.model,
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
    await tracer.span('model.usage', used, () => Promise.resolve());
    return result;
  });
}

/** Every member of the provider, and how it is wrapped: the two calls traced, `health` as it is. */
const MODEL_RULES: MemberRules<ModelProvider, Tracer> = {
  generate: (model, tracer) => (request) =>
    measured(tracer, 'generate', request.role, request.model, () => model.generate(request)),
  decide: (model, tracer) => (request) =>
    measured(tracer, 'decide', request.role, undefined, () => model.decide(request)),
  health: (model) => () => model.health(),
};

/**
 * The same provider, with one span around every generate and decide call (F45, D7). The span
 * carries the role and, when the caller named one, the model; its length is the latency.
 *
 * `Tracer.span` fixes a span's attributes when it starts, and the model, latency and token counts
 * are only known when the call ends. So the answer's numbers go on a short `model.usage` span
 * inside the call span. Never a prompt, a system text, item text or an answer: those can hold
 * collected text. A failure passes through; the tracer records it on the call span.
 */
export function traceModel(model: ModelProvider, tracer: Tracer): ModelProvider {
  return decorate(model, tracer, MODEL_RULES);
}

/**
 * A tracer that hands spans to the real one once `bind` has been given it; until then they run
 * untraced. The container needs it because the real tracer registers itself process-wide, so it
 * is built last, after the model and the guards that use `traceModel`.
 */
export function deferTracer(): { tracer: Tracer; bind: (real: Tracer) => void } {
  let target: Tracer = noopTracer;
  return {
    tracer: { span: (name, attributes, fn) => target.span(name, attributes, fn) },
    bind: (real) => {
      target = real;
    },
  };
}
