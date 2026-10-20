import { errorMessage } from '../../../shared/errors';
import { withRetry, withTimeout } from '../../../shared/retry';
import type { Usage } from '../../ModelProvider';
import type { Role } from '../../roles';
import { isRetryable, toDigestError } from '../ollamaHttp';
import type { CallSpec, OllamaContext } from './types';

/** Per-role timeout for one attempt (spec defaults); `timeoutsMs` overrides them. */
export const DEFAULT_TIMEOUTS_MS: Readonly<Record<Role, number>> = {
  classify: 60_000,
  guardPolicy: 60_000,
  guardRisk: 120_000,
  judge: 120_000,
  write: 600_000,
};
/**
 * Added to the timeout of a call whose model is not loaded yet. The first `guardPolicy` call to
 * `clef:latest` on a 32 GB M1 Pro (2026-10-19) timed out at 60 s while the model loaded and took
 * 107 s with its retry; 5 min is about three times that.
 */
export const DEFAULT_COLD_START_MS = 300_000;
/** Spec: 2 retries with backoff. */
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 10_000;

/**
 * One model call: per-role timeout per attempt (longer while the model is cold), retries with
 * backoff on retryable errors, `parse` on the payload, one log line. Failures become DigestErrors; caller aborts pass through.
 */
export async function callOllama<T extends { usage: Usage }>(
  { http, options, loads }: OllamaContext,
  spec: CallSpec,
  parse: (raw: unknown) => T,
): Promise<T & { latencyMs: number }> {
  const log = options.logger.child({ ...spec.logFields, role: spec.role, model: spec.model });
  const cold = loads.isCold(spec.model);
  const coldStartMs = cold ? (options.coldStartMs ?? DEFAULT_COLD_START_MS) : 0;
  const timeoutMs =
    (options.timeoutsMs?.[spec.role] ?? DEFAULT_TIMEOUTS_MS[spec.role]) + coldStartMs;
  const started = performance.now();
  let attempts = 0;
  try {
    const raw = await withRetry(
      (attempt) => {
        attempts = attempt + 1;
        return withTimeout(spec.send, timeoutMs, spec.signal);
      },
      {
        retries: options.retries ?? DEFAULT_RETRIES,
        baseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
        maxDelayMs: RETRY_MAX_DELAY_MS,
        shouldRetry: (error) => !spec.signal?.aborted && isRetryable(error),
        onRetry: (error, attempt) => {
          log.warn('ollama call failed, retrying', {
            op: spec.op,
            attempt: attempt + 1,
            error: errorMessage(error),
          });
        },
      },
    );
    loads.markLoaded(spec.model);
    const value = parse(raw);
    const latencyMs = Math.round(performance.now() - started);
    log.info('ollama call', {
      op: spec.op,
      latencyMs,
      attempts,
      ...(cold ? { coldStart: true } : {}),
      ...value.usage,
    });
    return { ...value, latencyMs };
  } catch (error) {
    const fields = { op: spec.op, latencyMs: Math.round(performance.now() - started), attempts };
    if (spec.signal?.aborted) {
      log.warn('ollama call aborted', fields);
      throw error;
    }
    log.error('ollama call failed', { ...fields, error: errorMessage(error) });
    throw toDigestError(error, { ...spec, baseUrl: http.baseUrl, timeoutMs });
  }
}
