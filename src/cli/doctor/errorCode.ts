/** The `code` of a Node system error ("ENOENT", "EACCES"), or undefined for any other error. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** True for a missing path (ENOENT). */
export function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}
