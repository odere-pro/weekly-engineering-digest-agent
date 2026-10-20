import { stat } from 'node:fs/promises';

/**
 * The `code` of a Node system error ("ENOENT", "EACCES", "EEXIST"), or undefined for anything
 * else: a value that is not an `Error`, an error with no code, a code that is not a string.
 * Compare it: `errnoCode(error) === 'ENOENT'`.
 */
export function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/**
 * True when the error says the path is not there: it is missing (ENOENT) or a parent in it is a
 * file (ENOTDIR). Anything else (EACCES, EIO, ELOOP) says nothing about whether it exists.
 * To read one file that "may be missing", check `errnoCode(error) === 'ENOENT'` instead: ENOTDIR
 * there means the folder layout is wrong, which is worth reporting.
 */
export function isNotFound(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Whether `path` exists, following links. False when it is not there (`isNotFound`), true when
 * `stat` works, and anything else (EACCES, EIO, ELOOP) is rethrown: a path that cannot be checked
 * is neither there nor missing, and the caller decides what that means.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}
