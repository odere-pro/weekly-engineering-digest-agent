import { errorMessage } from '../../shared/errors.js';

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
 * An error for a failed call whose message may echo a credential. It deliberately has no `cause`:
 * the original error would carry the unredacted text into logs and run records.
 */
export function redactedError(prefix: string, error: unknown, secrets: readonly string[]): Error {
  return new Error(`${prefix}: ${redactSecrets(errorMessage(error), secrets)}`);
}
