import { describe, expect, it } from 'vitest';
import { deferTracer, traceModel } from './tracedModel';
import type { DecideRequest, GenerateRequest, ModelProvider } from '../models/ModelProvider';
import type { LogFields, Tracer } from '../shared/telemetry';
import { FakeModelProvider, yesNoAnswers } from '../../test/fakes';

interface RecordedSpan {
  name: string;
  attributes: LogFields;
  /** Names of the spans open when this one started, outermost first. */
  parents: string[];
}

/** Runs every span's function and writes down what the span was given. */
function recordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const open: string[] = [];
  const tracer: Tracer = {
    span: async (name, attributes, fn) => {
      spans.push({ name, attributes, parents: [...open] });
      open.push(name);
      try {
        return await fn();
      } finally {
        open.pop();
      }
    },
  };
  return { tracer, spans };
}

const PROMPT = 'PROMPT-TEXT-secret-sauce';
const SYSTEM = 'SYSTEM-TEXT-do-not-leak';
const STATE = 'STATE-TEXT-item-body';

const generateRequest: GenerateRequest = {
  role: 'write',
  model: 'writer-a:latest',
  system: SYSTEM,
  prompt: PROMPT,
};
const decideRequest: DecideRequest = {
  role: 'classify',
  state: STATE,
  questions: { area: { type: 'yesno', instructions: 'QUESTION-TEXT' } },
};

function setup(options: ConstructorParameters<typeof FakeModelProvider>[0] = {}) {
  const inner = new FakeModelProvider({
    generate: () => 'draft',
    decide: (request) => yesNoAnswers(request, 0.9),
    ...options,
  });
  const { tracer, spans } = recordingTracer();
  return { inner, spans, model: traceModel(inner, tracer) };
}

describe('traceModel', () => {
  it('returns what the provider returned for generate', async () => {
    const { model } = setup();

    const result = await model.generate(generateRequest);

    expect(result).toMatchObject({ model: 'writer-a:latest', text: 'draft', latencyMs: 1 });
  });

  it('returns what the provider returned for decide', async () => {
    const { model } = setup();

    const result = await model.decide(decideRequest);

    expect(result.model).toBe('fake-classify');
    expect(result.answers).toEqual({ area: { type: 'yesno', probability: 0.9 } });
  });

  it('hands the request to the provider as it is', async () => {
    const { model, inner } = setup();

    await model.generate(generateRequest);
    await model.decide(decideRequest);

    expect(inner.generateCalls[0]).toBe(generateRequest);
    expect(inner.decideCalls[0]).toBe(decideRequest);
  });

  it('opens one span around a generate call, with its role and the model asked for', async () => {
    const { model, spans } = setup();

    await model.generate(generateRequest);

    expect(spans[0]).toEqual({
      name: 'model.generate',
      attributes: { role: 'write', model: 'writer-a:latest' },
      parents: [],
    });
  });

  it('leaves the model out of the span when the role picks it', async () => {
    const { model, spans } = setup();

    await model.generate({ role: 'guardRisk', system: SYSTEM, prompt: PROMPT });

    expect(spans[0]?.attributes).toEqual({ role: 'guardRisk' });
  });

  it('opens one span around a decide call', async () => {
    const { model, spans } = setup();

    await model.decide(decideRequest);

    expect(spans[0]).toEqual({
      name: 'model.decide',
      attributes: { role: 'classify' },
      parents: [],
    });
  });

  it('records the model, latency and tokens in a span inside the call span', async () => {
    const { model, spans } = setup();

    await model.generate(generateRequest);

    expect(spans).toHaveLength(2);
    expect(spans[1]).toEqual({
      name: 'model.usage',
      attributes: {
        role: 'write',
        model: 'writer-a:latest',
        latencyMs: 1,
        inputTokens: PROMPT.length,
        outputTokens: 'draft'.length,
      },
      parents: ['model.generate'],
    });
  });

  it('records the usage of a decide call with the model the provider resolved', async () => {
    const { model, spans } = setup();

    await model.decide(decideRequest);

    expect(spans[1]?.attributes).toEqual({
      role: 'classify',
      model: 'fake-classify',
      latencyMs: 1,
      inputTokens: STATE.length,
      outputTokens: 1,
    });
  });

  it('puts no prompt, system text, state or question in any span', async () => {
    const { model, spans } = setup();

    await model.generate(generateRequest);
    await model.decide(decideRequest);

    const everything = JSON.stringify(spans);
    for (const text of [PROMPT, SYSTEM, STATE, 'QUESTION-TEXT', 'draft']) {
      expect(everything).not.toContain(text);
    }
  });

  it('lets a failure through to the caller and records no usage', async () => {
    const failure = new Error('Ollama is down');
    const { model, spans } = setup({
      generate: () => {
        throw failure;
      },
    });

    await expect(model.generate(generateRequest)).rejects.toBe(failure);

    expect(spans.map((span) => span.name)).toEqual(['model.generate']);
  });

  it('answers health without a span', async () => {
    const { model, spans } = setup();

    await expect(model.health()).resolves.toMatchObject({ reachable: true });

    expect(spans).toEqual([]);
  });

  it('calls the provider as a method, so it keeps its own state', async () => {
    const { model, inner } = setup();

    await model.generate(generateRequest);

    expect(inner.generateCalls).toHaveLength(1);
  });
});

describe('traceModel wraps every member of the provider', () => {
  interface MemberCase {
    call: (model: ModelProvider) => Promise<unknown>;
    /** The span the member opens; none for a member that is passed through. */
    span: string | undefined;
  }
  // A member added to `ModelProvider` is a type error here until it has a case: traced or not.
  const MEMBERS: Record<keyof ModelProvider, MemberCase> = {
    generate: { call: (model) => model.generate(generateRequest), span: 'model.generate' },
    decide: { call: (model) => model.decide(decideRequest), span: 'model.decide' },
    health: { call: (model) => model.health(), span: undefined },
  };

  it.each(Object.keys(MEMBERS) as (keyof ModelProvider)[])(
    '%s reaches the provider and is traced as it should be',
    async (member) => {
      const { model, inner, spans } = setup();
      const { call, span } = MEMBERS[member];
      const direct = await call(inner);

      const traced = await call(model);

      expect(traced).toEqual(direct);
      expect(spans.map((each) => each.name)).toEqual(
        span === undefined ? [] : [span, 'model.usage'],
      );
    },
  );

  it('wraps nothing else: the provider has exactly the members of the port', () => {
    const { model } = setup();

    expect(Object.keys(model).sort()).toEqual(Object.keys(MEMBERS).sort());
  });
});

describe('deferTracer', () => {
  it('runs a span untraced until it is bound', async () => {
    const { tracer } = deferTracer();

    await expect(tracer.span('early', { a: 1 }, () => Promise.resolve('done'))).resolves.toBe(
      'done',
    );
  });

  it('hands spans to the tracer it is bound to, including ones from before it was bound', async () => {
    const { tracer: deferred, bind } = deferTracer();
    const { tracer: real, spans } = recordingTracer();
    const before = traceModel(new FakeModelProvider({ generate: () => 'x' }), deferred);

    bind(real);
    await before.generate(generateRequest);

    expect(spans.map((span) => span.name)).toEqual(['model.generate', 'model.usage']);
  });

  it('passes the failure of a span on', async () => {
    const { tracer, bind } = deferTracer();
    bind(recordingTracer().tracer);
    const failure = new Error('boom');

    await expect(tracer.span('s', {}, () => Promise.reject(failure))).rejects.toBe(failure);
  });
});
