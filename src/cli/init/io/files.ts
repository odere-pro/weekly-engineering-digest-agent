import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathExists } from '../../../shared/fsErrors';

/**
 * False only for a path that is not there (`pathExists`: ENOENT, or ENOTDIR below a file). When
 * the path cannot be checked (a folder it may not read), it may exist: the answer is true, and
 * the caller then asks before it overwrites. `pathExists` itself rethrows that case.
 */
export async function mayExist(path: string): Promise<boolean> {
  try {
    return await pathExists(path);
  } catch {
    return true;
  }
}

/** Writes a normal file, creating its folder. */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/** True for an existing file with no content, such as the ones `make docker-init` creates. */
export async function isEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size === 0;
  } catch {
    // Unreadable counts as "has content": the caller then asks before overwriting.
    return false;
  }
}
