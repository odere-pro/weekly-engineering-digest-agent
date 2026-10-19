import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { errorCode } from '../../doctor/errorCode';

/**
 * False only for a path that is not there (ENOENT) or sits below a file (ENOTDIR). Any other
 * failure, such as a folder it may not read, counts as "exists": the caller then asks before
 * it overwrites.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const code = errorCode(error);
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/** The text of a file, undefined when it does not exist. Other failures reject. */
export async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
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
