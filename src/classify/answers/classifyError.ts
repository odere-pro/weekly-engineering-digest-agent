import { DigestError } from '../../shared/errors';

/** A `DigestError` of step `classify`, so a bad answer fails the run instead of guessing a score. */
export function classifyError(message: string): DigestError {
  return new DigestError(`classify: ${message}`, { step: 'classify' });
}
