/** True for a Node file system error with this code (`ENOENT`, `EEXIST`, ...). */
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
