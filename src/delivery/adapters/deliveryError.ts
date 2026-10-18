import { errorMessage } from '../../shared/errors';

/** An error and the causes below it are read or copied up to this many levels; the rest is cut. */
export const MAX_CAUSE_DEPTH = 5;

/** A code or timeout type is a short identifier; anything else is text that may carry a secret. */
const IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/;

/**
 * What a retry decision needs from a failed delivery: plain values copied from the failed call,
 * never text of it. The retry logic reads these instead of matching on the message.
 */
export interface DeliveryErrorFacts {
  /** Node, undici or nodemailer code: `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, `ESOCKET`, ... */
  readonly code?: string;
  /** The system code nodemailer replaced with its own `code` (`ESOCKET` over `ECONNREFUSED`). */
  readonly originalCode?: string;
  /** HTTP status of an answer (Slack). */
  readonly status?: number;
  /** SMTP reply code of an answer from the mail server (421, 550). */
  readonly responseCode?: number;
  /** Which timeout nodemailer hit: `CONNECT_TIMEOUT`, `GREETING_TIMEOUT`, `SOCKET_TIMEOUT`, ... */
  readonly timeoutType?: string;
}

export interface DeliveryErrorOptions extends DeliveryErrorFacts {
  /** Must already be free of secrets (see `redactedError`). */
  readonly cause?: unknown;
  /** The name to show; default `DeliveryError`. */
  readonly name?: string;
}

/** A delivery that failed, with the facts that tell whether sending again could double a message. */
export class DeliveryError extends Error implements DeliveryErrorFacts {
  readonly code?: string;
  readonly originalCode?: string;
  readonly status?: number;
  readonly responseCode?: number;
  readonly timeoutType?: string;

  constructor(message: string, options: DeliveryErrorOptions = {}) {
    // `{ cause: undefined }` would still give the error an own `cause` property.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = options.name ?? 'DeliveryError';
    this.code = options.code;
    this.originalCode = options.originalCode;
    this.status = options.status;
    this.responseCode = options.responseCode;
    this.timeoutType = options.timeoutType;
  }
}

function identifierOf(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined;
}

function integerOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/**
 * The facts one thrown value states itself. A DOMException's numeric `code` and any code that is
 * not a plain identifier are left out.
 */
export function statedFacts(value: unknown): DeliveryErrorFacts {
  if (typeof value !== 'object' || value === null) return {};
  const stated = value as Readonly<Record<string, unknown>>;
  return {
    code: identifierOf(stated.code),
    originalCode: identifierOf(stated.originalCode),
    status: integerOf(stated.status),
    responseCode: integerOf(stated.responseCode),
    timeoutType: identifierOf(stated.timeoutType),
  };
}

/** The cause of an error, or nothing for a value that has none. */
export function causeOf(value: unknown): unknown {
  return value instanceof Error ? value.cause : undefined;
}

/**
 * The facts of a failed call. `fetch` reports `fetch failed` and puts the code on the cause, so
 * each fact comes from the outermost error in the chain that states it.
 */
export function deliveryFacts(error: unknown): DeliveryErrorFacts {
  let facts: DeliveryErrorFacts = {};
  let node = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && node !== undefined && node !== null; depth++) {
    const stated = statedFacts(node);
    facts = {
      code: facts.code ?? stated.code,
      originalCode: facts.originalCode ?? stated.originalCode,
      status: facts.status ?? stated.status,
      responseCode: facts.responseCode ?? stated.responseCode,
      timeoutType: facts.timeoutType ?? stated.timeoutType,
    };
    node = causeOf(node);
  }
  return facts;
}

/**
 * The text of a failed call. An `AggregateError` (a host that refuses both its IPv4 and IPv6
 * address) has no message of its own, so its text is its inner errors' messages, each once.
 */
export function describeError(error: unknown, depth = 0): string {
  if (error instanceof AggregateError && error.message === '' && depth < MAX_CAUSE_DEPTH) {
    const inner = error.errors.map((each: unknown) => describeError(each, depth + 1));
    return [...new Set(inner.filter((message) => message !== ''))].join('; ');
  }
  return errorMessage(error);
}
