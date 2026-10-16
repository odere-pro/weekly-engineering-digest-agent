import type { Tracer } from '../shared/telemetry.js';
import { NotImplementedError } from '../shared/errors.js';

export interface TracingHandle extends Tracer {
  shutdown(): Promise<void>;
}

/** OpenTelemetry tracer when an OTLP endpoint is set, otherwise a no-op (W1-15). */
export function createTracer(_options: { endpoint?: string; serviceName?: string }): TracingHandle {
  throw new NotImplementedError('W1-15');
}
