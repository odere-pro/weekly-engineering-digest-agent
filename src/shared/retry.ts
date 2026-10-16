export interface RetryOptions {
  /** Extra attempts after the first one. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Runs `fn` with exponential backoff. `attempt` starts at 0. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const maxDelay = options.maxDelayMs ?? Number.POSITIVE_INFINITY;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const canRetry = attempt < options.retries && (options.shouldRetry?.(error, attempt) ?? true);
      if (!canRetry) throw error;
      options.onRetry?.(error, attempt);
      await sleep(Math.min(options.baseDelayMs * 2 ** attempt, maxDelay));
    }
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Runs `fn` with an AbortSignal that fires after `ms` (or when `parent` aborts).
 * Rejects with TimeoutError on timeout even if `fn` ignores the signal.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = (): void => {
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) controller.abort(parent.reason);
  parent?.addEventListener('abort', onParentAbort, { once: true });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(ms);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParentAbort);
  }
}
