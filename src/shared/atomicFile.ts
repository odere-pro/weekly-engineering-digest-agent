import { randomUUID } from 'node:crypto';
import { link, lstat, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from './errors';

const TEMP_SUFFIX = '.tmp';
/** The `<pid>.<uuid>` between a file's name and `.tmp` in the names `tempFilePath` builds. */
const TEMP_IDENTITY = /^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isErrnoException(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** A unique name for a temp file next to `path`. `isTempFileOf` recognises exactly these. */
function tempFilePath(path: string): string {
  return `${path}.${String(process.pid)}.${randomUUID()}${TEMP_SUFFIX}`;
}

/** True when `name` is a name that `tempFilePath` builds for a file called `base`. */
function isTempFileOf(name: string, base: string): boolean {
  const prefix = `${base}.`;
  if (!name.startsWith(prefix) || !name.endsWith(TEMP_SUFFIX)) return false;
  return TEMP_IDENTITY.test(name.slice(prefix.length, name.length - TEMP_SUFFIX.length));
}

/** Writes `content` to a fresh file next to `path` and flushes it to disk. Returns its path. */
async function writeTempFile(path: string, content: string): Promise<string> {
  const tempPath = tempFilePath(path);
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
 * Needs a file system with hard links (`link` fails with EPERM or ENOTSUP on FAT, exFAT and some
 * network or FUSE mounts).
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

export interface TempSweepOptions {
  /** Files at least this old are removed. */
  maxAgeMs: number;
  now: Date;
}

export interface TempSweepResult {
  /** Names (not paths) of the files that were removed. */
  removed: readonly string[];
  /** Files that matched and were old enough, but could not be removed. */
  failed: readonly { name: string; error: string }[];
}

type SweepOutcome =
  | { kind: 'removed'; name: string }
  | { kind: 'failed'; name: string; error: string }
  | { kind: 'kept' };

async function listNames(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch (error) {
    if (isErrnoException(error, 'ENOENT')) return [];
    throw error;
  }
}

/** Removes one regular file that is old enough. A file that is gone by now is not our removal. */
async function removeIfStale(
  folder: string,
  name: string,
  options: TempSweepOptions,
): Promise<SweepOutcome> {
  const path = join(folder, name);
  try {
    // lstat: a symlink or a directory with a temp file's name is not ours to remove.
    const info = await lstat(path);
    // An age below zero (a change time in the future) never qualifies.
    if (!info.isFile() || options.now.getTime() - info.mtimeMs < options.maxAgeMs) {
      return { kind: 'kept' };
    }
    await unlink(path);
    return { kind: 'removed', name };
  } catch (error) {
    // Another run may have removed it since we looked: nothing left to do, nothing to report.
    if (isErrnoException(error, 'ENOENT')) return { kind: 'kept' };
    return { kind: 'failed', name, error: errorMessage(error) };
  }
}

/**
 * Removes the temp files that `writeFileAtomic` and `createFileExclusive` leave in `folder` for
 * the files called `names`, when their process dies between creating a temp file and renaming or
 * removing it (a SIGKILL, a power cut). Only files named exactly `<name>.<pid>.<uuid>.tmp`, at
 * least `maxAgeMs` old, are removed: a younger one may belong to a writer that is still running.
 * Per-file failures are reported in the result; an unreadable folder throws.
 */
export async function removeStaleTempFiles(
  folder: string,
  names: readonly string[],
  options: TempSweepOptions,
): Promise<TempSweepResult> {
  const candidates = (await listNames(folder)).filter((name) =>
    names.some((base) => isTempFileOf(name, base)),
  );
  const outcomes = await Promise.all(
    candidates.map((name) => removeIfStale(folder, name, options)),
  );
  return {
    removed: outcomes.flatMap((outcome) => (outcome.kind === 'removed' ? [outcome.name] : [])),
    failed: outcomes.flatMap((outcome) =>
      outcome.kind === 'failed' ? [{ name: outcome.name, error: outcome.error }] : [],
    ),
  };
}
