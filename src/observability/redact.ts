import type { LogFields } from '../shared/telemetry';

export const REDACTED = '[redacted]';
export const CIRCULAR = '[circular]';
export const TRUNCATED = '[truncated]';
export const UNSERIALIZABLE = '[unserializable]';

/** Log fields are shallow; anything deeper is a mistake or a hostile structure. */
const MAX_DEPTH = 10;

export interface Redactor {
  /** Replaces every secret occurrence in a string. */
  text(value: string): string;
  /** Returns a copy of `value` with secrets removed from every nested string and key. */
  value(value: unknown): unknown;
  /**
   * Same as `value` for a field bag. Never throws: fields that cannot be read are replaced by
   * `{ fields: '[unserializable]' }` so a logging call can never break the pipeline.
   */
  fields(fields: LogFields): LogFields;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The secret as written, percent-encoded (URLs) and JSON-escaped (stringified payloads). */
function variantsOf(secret: string): string[] {
  return [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
}

/** One alternation, longest first, so a short secret never splits a longer one. */
function secretPattern(secrets: readonly string[]): RegExp | undefined {
  const ordered = [
    ...new Set(secrets.filter((secret) => secret.length > 0).flatMap(variantsOf)),
  ].sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return undefined;
  return new RegExp(ordered.map(escapeRegExp).join('|'), 'g');
}

function binarySize(value: object): number | undefined {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength;
  return undefined;
}

/** Builds a redactor for the given secret values. Never mutates its input. */
export function createRedactor(secrets: readonly string[] = []): Redactor {
  const pattern = secretPattern(secrets);
  const text = (value: string): string =>
    pattern === undefined ? value : value.replace(pattern, REDACTED);

  function walk(value: unknown, depth: number, ancestors: Set<object>): unknown {
    if (typeof value === 'string') return text(value);
    if (typeof value !== 'object' || value === null) return value;
    const size = binarySize(value);
    if (size !== undefined) return `[binary ${size.toString()} bytes]`;
    if (depth > MAX_DEPTH) return TRUNCATED;
    if (ancestors.has(value)) return CIRCULAR;

    ancestors.add(value);
    try {
      return walkObject(value, depth, ancestors);
    } finally {
      ancestors.delete(value);
    }
  }

  function walkEntries(
    value: object,
    depth: number,
    ancestors: Set<object>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [text(key), walk(item, depth + 1, ancestors)]),
    );
  }

  function walkObject(value: object, depth: number, ancestors: Set<object>): unknown {
    if (Array.isArray(value)) return value.map((item: unknown) => walk(item, depth + 1, ancestors));
    if (value instanceof Error) return walkError(value, depth, ancestors);
    if ('toJSON' in value && typeof value.toJSON === 'function') {
      return walk((value.toJSON as () => unknown)(), depth + 1, ancestors);
    }
    return walkEntries(value, depth, ancestors);
  }

  function walkError(error: Error, depth: number, ancestors: Set<object>): Record<string, unknown> {
    return {
      ...walkEntries(error, depth, ancestors),
      type: text(error.name),
      message: text(error.message),
      ...(error.stack === undefined ? {} : { stack: text(error.stack) }),
      ...(error.cause === undefined ? {} : { cause: walk(error.cause, depth + 1, ancestors) }),
      ...(error instanceof AggregateError
        ? { errors: walk(error.errors, depth + 1, ancestors) }
        : {}),
    };
  }

  return {
    text,
    value: (value) => {
      try {
        return walk(value, 0, new Set());
      } catch {
        return UNSERIALIZABLE;
      }
    },
    fields: (fields) => {
      try {
        return walk(fields, 0, new Set()) as LogFields;
      } catch {
        return { fields: UNSERIALIZABLE };
      }
    },
  };
}
