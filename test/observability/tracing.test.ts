import { SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { createTracer, type TracingHandle } from '../../src/observability/tracing.js';

const ENDPOINT = 'http://localhost:4318/v1/traces';

/** Keeps spans after shutdown so tests can read what the flush exported. */
class RetainingExporter extends InMemorySpanExporter {
  override shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

let active: TracingHandle | undefined;

function tracerWith(
  exporter: RetainingExporter,
  options: {
    serviceName?: string;
    redactValues?: readonly string[];
    shutdownTimeoutMs?: number;
  } = {},
): TracingHandle {
  active = createTracer({ endpoint: ENDPOINT, exporter, ...options });
  return active;
}

afterEach(async () => {
  await active?.shutdown().catch(() => undefined);
  active = undefined;
});

describe('createTracer without an endpoint', () => {
  it('runs the function and returns its value', async () => {
    const tracer = createTracer({});
    await expect(tracer.span('step', { a: 1 }, () => Promise.resolve(42))).resolves.toBe(42);
    await expect(tracer.shutdown()).resolves.toBeUndefined();
  });

  it('propagates errors unchanged', async () => {
    const tracer = createTracer({ endpoint: '' });
    const boom = new Error('boom');
    await expect(tracer.span('step', {}, () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe('createTracer with an endpoint', () => {
  it('records a span with the name, attributes and OK outcome', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter, { serviceName: 'digest-test' });

    const result = await tracer.span(
      'step.write',
      {
        runId: 'r1',
        tokens: 7,
        cached: false,
        tags: ['a', 'b'],
        skipped: undefined,
        missing: null,
      },
      () => Promise.resolve('done'),
    );
    await tracer.shutdown();

    expect(result).toBe('done');
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('step.write');
    expect(span?.attributes).toMatchObject({
      runId: 'r1',
      tokens: 7,
      cached: false,
      tags: ['a', 'b'],
    });
    expect(span?.attributes).not.toHaveProperty('skipped');
    expect(span?.attributes).not.toHaveProperty('missing');
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span?.resource.attributes['service.name']).toBe('digest-test');
  });

  it('defaults the service name', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter);

    await tracer.span('s', {}, () => Promise.resolve());
    await tracer.shutdown();

    expect(exporter.getFinishedSpans()[0]?.resource.attributes['service.name']).toBe('eng-digest');
  });

  it('stringifies attribute values OpenTelemetry cannot carry', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter);

    await tracer.span('s', { meta: { a: 1 }, mixed: [1, 'x'], big: 10n }, () => Promise.resolve());
    await tracer.shutdown();

    expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
      meta: '{"a":1}',
      mixed: '[1,"x"]',
      big: '10',
    });
  });

  it('records the exception, sets error status, ends the span and rethrows', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter);
    const boom = new RangeError('model exploded');

    await expect(tracer.span('model.call', {}, () => Promise.reject(boom))).rejects.toBe(boom);
    await tracer.shutdown();

    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'model exploded' });
    expect(span?.events.map((event) => event.name)).toContain('exception');
    expect(span?.events[0]?.attributes).toMatchObject({
      'exception.type': 'RangeError',
      'exception.message': 'model exploded',
    });
    expect(span?.endTime).toBeDefined();
  });

  it('handles non-Error rejections', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter);

    // A callback may reject with a non-Error; the tracer must cope with it.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const rejecting = () => Promise.reject('plain string');
    await expect(tracer.span('s', {}, rejecting)).rejects.toBe('plain string');
    await tracer.shutdown();

    expect(exporter.getFinishedSpans()[0]?.status).toMatchObject({
      code: SpanStatusCode.ERROR,
      message: 'plain string',
    });
  });

  it('nests spans: a model call span is a child of the step span', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter);

    await tracer.span('step.write', {}, () =>
      tracer.span('model.generate', {}, () => Promise.resolve()),
    );
    await tracer.shutdown();

    const spans = exporter.getFinishedSpans();
    const step = spans.find((span) => span.name === 'step.write');
    const model = spans.find((span) => span.name === 'model.generate');
    expect(model?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId);
    expect(model?.spanContext().traceId).toBe(step?.spanContext().traceId);
  });

  it('redacts secret values in attributes, exception events and status', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter, { redactValues: ['hunter2', ''] });

    await expect(
      tracer.span('s', { url: 'https://x.test/?k=hunter2', list: ['hunter2'] }, () =>
        Promise.reject(new Error('denied for hunter2')),
      ),
    ).rejects.toThrow('denied');
    await tracer.shutdown();

    const [span] = exporter.getFinishedSpans();
    expect(JSON.stringify(span?.attributes)).not.toContain('hunter2');
    expect(span?.attributes['url']).toBe('https://x.test/?k=[redacted]');
    expect(span?.status.message).toBe('denied for [redacted]');
    expect(JSON.stringify(span?.events)).not.toContain('hunter2');
  });

  it('releases the global tracer provider on shutdown so a new tracer can register', async () => {
    const first = new RetainingExporter();
    const one = createTracer({ endpoint: ENDPOINT, exporter: first });
    await one.span('one', {}, () => Promise.resolve());
    await one.shutdown();

    const second = new RetainingExporter();
    const two = createTracer({ endpoint: ENDPOINT, exporter: second });
    await two.span('two', {}, () => Promise.resolve());
    await two.shutdown();

    expect(first.getFinishedSpans().map((span) => span.name)).toEqual(['one']);
    expect(second.getFinishedSpans().map((span) => span.name)).toEqual(['two']);
  });

  it('builds an OTLP exporter from the endpoint when no exporter is injected', async () => {
    const tracer = createTracer({ endpoint: ENDPOINT });
    await expect(tracer.shutdown()).resolves.toBeUndefined();
  });

  it('shares one shutdown between repeated calls', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter);

    await tracer.span('s', {}, () => Promise.resolve());
    const first = tracer.shutdown();
    const second = tracer.shutdown();

    expect(second).toBe(first);
    await first;
  });

  it('rejects instead of hanging when the collector never answers', async () => {
    const stuck: SpanExporter = {
      export: () => undefined,
      shutdown: () => Promise.resolve(),
    };
    active = createTracer({ endpoint: ENDPOINT, exporter: stuck, shutdownTimeoutMs: 20 });

    await active.span('s', {}, () => Promise.resolve());

    await expect(active.shutdown()).rejects.toThrow(/did not finish within 20ms/);
  });
});

describe('createTracer hardening', () => {
  it('redacts the span name and attribute keys', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter, { redactValues: ['hunter2'] });

    await tracer.span('fetch https://x.test/?k=hunter2', { k_hunter2: 1 }, () => Promise.resolve());
    await tracer.shutdown();

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('fetch https://x.test/?k=[redacted]');
    expect(span?.attributes).toEqual({ 'k_[redacted]': 1 });
  });

  it('redacts a secret carried by a non-Error rejection', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter, { redactValues: ['hunter2'] });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const rejecting = () => Promise.reject('denied: hunter2');

    await expect(tracer.span('s', {}, rejecting)).rejects.toBe('denied: hunter2');
    await tracer.shutdown();

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.message).toBe('denied: [redacted]');
    expect(JSON.stringify(span?.events)).not.toContain('hunter2');
  });

  it('still runs the function when an attribute cannot be read', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter);
    const hostile = {
      get boom(): string {
        throw new Error('getter exploded');
      },
    };

    await expect(tracer.span('s', hostile, () => Promise.resolve('ran'))).resolves.toBe('ran');
    await tracer.shutdown();

    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({ fields: '[unserializable]' });
  });

  it('rethrows the original rejection even when it cannot be stringified', async () => {
    const exporter = new RetainingExporter();
    const tracer = tracerWith(exporter);
    const unprintable = Object.create(null) as object;
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const rejecting = () => Promise.reject(unprintable);

    await expect(tracer.span('s', {}, rejecting)).rejects.toBe(unprintable);
  });

  it('refuses a second live tracer and accepts one after shutdown', async () => {
    const first = tracerWith(new RetainingExporter());

    expect(() => createTracer({ endpoint: ENDPOINT, exporter: new RetainingExporter() })).toThrow(
      /already active/,
    );
    await first.shutdown();

    const again = new RetainingExporter();
    active = createTracer({ endpoint: ENDPOINT, exporter: again });
    await active.span('later', {}, () => Promise.resolve());
    await active.shutdown();
    expect(again.getFinishedSpans().map((span) => span.name)).toEqual(['later']);
  });

  it('registers the global tracer provider while active and releases it on shutdown', async () => {
    const tracer = tracerWith(new RetainingExporter());
    expect(trace.getTracer('probe').startSpan('during').isRecording()).toBe(true);

    await tracer.shutdown();

    expect(trace.getTracer('probe').startSpan('after').isRecording()).toBe(false);
  });
});
