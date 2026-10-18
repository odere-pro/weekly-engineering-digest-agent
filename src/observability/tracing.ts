import {
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type AttributeValue,
  type Exception,
  type Span,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { errorMessage } from '../shared/errors';
import type { LogFields, Tracer } from '../shared/telemetry';
import { UNSERIALIZABLE, createRedactor, type Redactor } from './redact';

export interface TracingHandle extends Tracer {
  /**
   * Flushes pending spans and releases the global OpenTelemetry registration. Rejects when the
   * flush fails or exceeds `shutdownTimeoutMs`: the caller decides whether a telemetry outage
   * matters (the registration is released either way). Repeated calls share one result.
   */
  shutdown(): Promise<void>;
}

export interface TracerOptions {
  /** OTLP/HTTP traces URL, e.g. http://localhost:4318/v1/traces. Unset: tracing is off. */
  endpoint?: string;
  serviceName?: string;
  /** Secret values that must never appear in spans. */
  redactValues?: readonly string[];
  /** Replaces the OTLP exporter. Injected for tests. */
  exporter?: SpanExporter;
  /**
   * Longest wait for the final flush. Also the OTLP exporter's own request timeout, so its
   * retry timers do not keep the process alive much longer when the collector is down.
   */
  shutdownTimeoutMs?: number;
}

const DEFAULT_SERVICE_NAME = 'eng-digest';
const TRACER_NAME = 'eng-digest';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

/** OpenTelemetry registers a process-wide provider and context manager: only one tracer at a time. */
let tracerIsActive = false;

type PrimitiveKind = 'string' | 'number' | 'boolean';

function primitiveKind(value: unknown): PrimitiveKind | undefined {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return undefined;
}

/** OpenTelemetry arrays must hold one primitive kind; anything else is serialised. */
function isPrimitiveArray(value: unknown[]): value is string[] | number[] | boolean[] {
  const kind = primitiveKind(value[0]);
  return (
    value.length === 0 ||
    (kind !== undefined && value.every((item) => primitiveKind(item) === kind))
  );
}

/** `value` is already redacted, so it can be serialised as is. */
function serialise(value: unknown): string | undefined {
  if (typeof value === 'bigint') return value.toString();
  try {
    return JSON.stringify(value);
  } catch {
    return UNSERIALIZABLE;
  }
}

function toAttributeValue(value: unknown): AttributeValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value) && isPrimitiveArray(value)) return value;
  return serialise(value);
}

/** Expects fields that already went through the redactor (keys and values). */
function toAttributes(redactedFields: LogFields): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(redactedFields)) {
    const attribute = toAttributeValue(value);
    if (attribute !== undefined) attributes[key] = attribute;
  }
  return attributes;
}

function toException(error: unknown, redactor: Redactor): Exception {
  if (!(error instanceof Error)) return redactor.text(errorMessage(error));
  return {
    name: redactor.text(error.name),
    message: redactor.text(error.message),
    ...(error.stack === undefined ? {} : { stack: redactor.text(error.stack) }),
  };
}

/** Best effort: telemetry must never replace the error the caller is about to see. */
function recordFailure(span: Span, error: unknown, redactor: Redactor): void {
  try {
    span.recordException(toException(error, redactor));
    span.setStatus({ code: SpanStatusCode.ERROR, message: redactor.text(errorMessage(error)) });
  } catch {
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}

function flushWithin(flush: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Trace flush did not finish within ${timeoutMs.toString()}ms`));
    }, timeoutMs);
    timer.unref();
  });
  return Promise.race([flush, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function createActiveTracer(options: TracerOptions & { endpoint: string }): TracingHandle {
  if (tracerIsActive) {
    throw new Error('A tracer is already active: await its shutdown() before creating another');
  }
  const redactor = createRedactor(options.redactValues);
  const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exporter =
    options.exporter ?? new OTLPTraceExporter({ url: options.endpoint, timeoutMillis: timeoutMs });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': options.serviceName ?? DEFAULT_SERVICE_NAME,
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  provider.register();
  tracerIsActive = true;
  const tracer = provider.getTracer(TRACER_NAME);

  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= flushWithin(provider.shutdown(), timeoutMs).finally(() => {
      trace.disable();
      context.disable();
      propagation.disable();
      tracerIsActive = false;
    });
    return closing;
  };

  return {
    span: (name, attributes, fn) =>
      tracer.startActiveSpan(
        redactor.text(name),
        { attributes: toAttributes(redactor.fields(attributes)) },
        async (span) => {
          try {
            return await fn();
          } catch (error) {
            recordFailure(span, error, redactor);
            throw error;
          } finally {
            span.end();
          }
        },
      ),
    shutdown,
  };
}

/** OpenTelemetry tracer when an OTLP endpoint is set, otherwise a no-op (W1-15). */
export function createTracer(options: TracerOptions): TracingHandle {
  const { endpoint } = options;
  if (endpoint === undefined || endpoint === '') {
    return { span: (_name, _attributes, fn) => fn(), shutdown: () => Promise.resolve() };
  }
  return createActiveTracer({ ...options, endpoint });
}
