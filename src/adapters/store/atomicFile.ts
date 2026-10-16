import { randomUUID } from 'node:crypto';
import { link, open, readFile, rename, rm } from 'node:fs/promises';

export function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Writes `content` to a fresh file next to `path` and flushes it to disk. Returns its path. */
async function writeTempFile(path: string, content: string): Promise<string> {
  const tempPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  return tempPath;
}

/** Writes via a temp file in the same folder, then renames, so readers never see half a file. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tempPath = await writeTempFile(path, content);
  try {
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/**
 * Creates `path` with `content` only if it does not exist yet, and never exposes a partial file:
 * the content is complete the moment the file appears. Returns false when `path` exists.
 */
export async function createFileExclusive(path: string, content: string): Promise<boolean> {
  const tempPath = await writeTempFile(path, content);
  try {
    await link(tempPath, path);
    return true;
  } catch (error) {
    if (isErrnoException(error, 'EEXIST')) return false;
    throw error;
  } finally {
    await rm(tempPath, { force: true });
  }
}

/** File content, or undefined when the file does not exist. Other errors propagate. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) return undefined;
    throw error;
  }
}
