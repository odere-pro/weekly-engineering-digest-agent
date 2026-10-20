/** An errno-style code such as `EIO`, `EACCES` or `ERR_INVALID_ARG_TYPE`. */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;
/** A class name such as `DigestError` or `ZodError`. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

const UNKNOWN_ERROR = 'unknown error';

/**
 * What a note may say about an error the run threw: its errno-style `code`, else its class
 * `name`, and only when it has that shape. Never its message or cause, which can hold paths,
 * secrets or feed text.
 */
export function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return UNKNOWN_ERROR;
  const { code } = error as { code?: unknown };
  if (typeof code === 'string' && CODE_PATTERN.test(code)) return code;
  return NAME_PATTERN.test(error.name) ? error.name : UNKNOWN_ERROR;
}

/**
 * The note of a week whose run threw instead of returning a result, so there is no record to
 * report: the scheduler composes it, from the week and `errorLabel` only.
 */
export function threwNote(weekId: string, label: string): string {
  return `The run for ${weekId} stopped before it saved a record (${label}).`;
}

/** The note of a week that never started because another run held the lock for the whole budget. */
export function lockNote(weekId: string): string {
  return `The run for ${weekId} did not start: another run held the run lock for the whole retry budget.`;
}
