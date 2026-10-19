export interface RetryOptions {
  /** Extra attempts after the first one. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Stops the retrying. Once it fires no attempt starts, a failed attempt is not retried and a
   * back-off ends at once; `withRetry` then rejects with the reason (or, for an attempt that was
   * already running, with its own error).
   */
  signal?: AbortSignal;
}

/**
 * Runs `fn` with exponential backoff. `attempt` starts at 0. An abort `signal` is checked before
 * every attempt and during every back-off.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { signal } = options;
  const maxDelay = options.maxDelayMs ?? Number.POSITIVE_INFINITY;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (error) {
      const canRetry =
        !signal?.aborted &&
        attempt < options.retries &&
        (options.shouldRetry?.(error, attempt) ?? true);
      if (!canRetry) throw error;
      options.onRetry?.(error, attempt);
      await backOff(Math.min(options.baseDelayMs * 2 ** attempt, maxDelay), options);
    }
  }
}

/**
 * Waits `ms` with the injected sleep or a timer. A fired `signal` ends the wait at once, and the
 * wait then throws the signal's reason.
 */
async function backOff(ms: number, { sleep, signal }: RetryOptions): Promise<void> {
  signal?.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let wake: () => void = () => undefined;
  const woken = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const slept =
    sleep?.(ms) ??
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
  signal?.addEventListener('abort', wake, { once: true });
  try {
    await Promise.race([slept, woken]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', wake);
  }
  signal?.throwIfAborted();
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
