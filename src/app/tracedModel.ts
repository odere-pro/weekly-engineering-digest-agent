import type { Role } from '../core/schemas.js';
import type { ModelProvider, Usage } from '../ports/ModelProvider.js';
import { noopTracer, type Tracer } from '../shared/telemetry.js';

interface Measured {
  model: string;
  usage: Usage;
  latencyMs: number;
}

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
  async function measured<T extends Measured>(
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
  return {
    generate: (request) =>
      measured('generate', request.role, request.model, () => model.generate(request)),
    decide: (request) => measured('decide', request.role, undefined, () => model.decide(request)),
    health: () => model.health(),
  };
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
