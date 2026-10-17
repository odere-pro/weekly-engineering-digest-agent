import {
  causeOf,
  DeliveryError,
  deliveryFacts,
  describeError,
  MAX_CAUSE_DEPTH,
  statedFacts,
  type DeliveryErrorFacts,
} from './deliveryError.js';

const REDACTED = '[redacted]';

/** Replaces every occurrence of each secret in `text`, so an error can be thrown or logged safely. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  // Longest first, so a secret that contains another one is not left half-redacted.
  return secrets
    .filter((secret) => secret.length > 0)
    .toSorted((a, b) => b.length - a.length)
    .reduce((safe, secret) => safe.replaceAll(secret, REDACTED), text);
}

/**
 * An error for a failed call whose message may echo a credential. It keeps what a retry needs
 * (`code`, `status`, the SMTP reply code) and a copy of the cause chain with every message and
 * name redacted. It never holds the original errors: they carry the unredacted text into logs
 * and run records.
 */
export function redactedError(
  prefix: string,
  error: unknown,
  secrets: readonly string[],
): DeliveryError {
  const facts = redactedFacts(deliveryFacts(error), secrets);
  const detail = redactSecrets(describeError(error), secrets);
  return new DeliveryError(messageOf(prefix, detail, facts), {
    ...facts,
    cause: redactedCause(causeOf(error), secrets, 1),
  });
}

/**
 * "prefix: detail". When the text never names the code (`fetch failed` hides ECONNREFUSED on its
 * cause), the code is added, so a failure note says more than that the call failed.
 */
function messageOf(
  prefix: string,
  detail: string,
  { code, originalCode }: DeliveryErrorFacts,
): string {
  const named = originalCode ?? code;
  if (named !== undefined && !detail.includes(named)) {
    return detail === '' ? `${prefix}: ${named}` : `${prefix}: ${detail} (${named})`;
  }
  return detail === '' ? prefix : `${prefix}: ${detail}`;
}

/**
 * The code fields are identifiers by construction, but they come from the error being redacted,
 * so a secret that happens to look like one is removed from them too.
 */
function redactedFacts(facts: DeliveryErrorFacts, secrets: readonly string[]): DeliveryErrorFacts {
  const clean = (text: string | undefined): string | undefined =>
    text === undefined ? undefined : redactSecrets(text, secrets);
  return {
    ...facts,
    code: clean(facts.code),
    originalCode: clean(facts.originalCode),
    timeoutType: clean(facts.timeoutType),
  };
}

/** A redacted copy of `value` and of the causes below it, or nothing when it has none. */
function redactedCause(
  value: unknown,
  secrets: readonly string[],
  depth: number,
): DeliveryError | undefined {
  if (value === undefined || value === null || depth >= MAX_CAUSE_DEPTH) return undefined;
  return new DeliveryError(redactSecrets(describeError(value), secrets), {
    ...redactedFacts(statedFacts(value), secrets),
    name: value instanceof Error ? redactSecrets(value.name, secrets) : undefined,
    cause: redactedCause(causeOf(value), secrets, depth + 1),
  });
}
