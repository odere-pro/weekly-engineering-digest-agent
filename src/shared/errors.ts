import { ExitCode, type StepName } from '../core/schemas.js';

/** An expected failure with the exit code the CLI should return. */
export class DigestError extends Error {
  readonly exitCode: ExitCode;
  readonly step: StepName | undefined;

  constructor(
    message: string,
    options: { exitCode?: ExitCode; step?: StepName; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'DigestError';
    this.exitCode = options.exitCode ?? ExitCode.Failed;
    this.step = options.step;
  }
}

/**
 * A feed or API request that failed. `status` is the HTTP status when a response came back;
 * `retryable` says whether another attempt can help (network errors and 5xx, not a 404).
 */
export class FetchError extends DigestError {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      status?: number;
      exitCode?: ExitCode;
      step?: StepName;
      cause?: unknown;
    },
  ) {
    super(message, options);
    this.name = 'FetchError';
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

/** Thrown by Wave 0 stubs until the owning issue implements the module. */
export class NotImplementedError extends Error {
  constructor(issueId: string) {
    super(`Not implemented yet (see issue ${issueId})`);
    this.name = 'NotImplementedError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
