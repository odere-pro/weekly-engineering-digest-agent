// Vendor-neutral logging and tracing used by the core. Implemented in src/observability.

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Logger that adds `fields` (runId, step, role, model ...) to every line. */
  child(fields: LogFields): Logger;
}

export interface Tracer {
  /** Runs `fn` inside a span named `name`. */
  span<T>(name: string, attributes: LogFields, fn: () => Promise<T>): Promise<T>;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

export const noopTracer: Tracer = {
  span: (_name, _attributes, fn) => fn(),
};
