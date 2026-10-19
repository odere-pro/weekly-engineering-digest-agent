import { z } from 'zod';
import { createFileExclusive, readTextIfExists } from '../../../shared/atomicFile';

/**
 * `hostname`, `token`, `pidNamespace` and `heartbeatAt` are missing in locks written by older
 * versions. A pid only means something where it was written, so a lock names its host (in Docker
 * the container id: a one-shot `docker compose run` has a different one than `serve`) and, on
 * Linux, its PID namespace (two containers that pin the same hostname still have their own pids).
 */
const LockFileSchema = z.object({
  pid: z.number().int().positive(),
  runId: z.string(),
  startedAt: z.iso.datetime({ offset: true }),
  hostname: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  pidNamespace: z.string().min(1).optional(),
  heartbeatAt: z.iso.datetime({ offset: true }).optional(),
});

/** A lock file as read from disk: any version of it. */
export type LockFile = z.infer<typeof LockFileSchema>;
/** A lock this process writes: always complete. */
export type OwnLock = LockFile & { hostname: string; token: string; heartbeatAt: string };

/** The lock in `text`, or undefined when it is not valid JSON or does not fit the schema. */
export function parseLockFile(text: string): LockFile | undefined {
  try {
    const parsed = LockFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The same lock, ignoring heartbeats. */
export function sameLock(a: LockFile, b: LockFile): boolean {
  return (
    a.pid === b.pid && a.runId === b.runId && a.startedAt === b.startedAt && a.token === b.token
  );
}

/** Creates the file only if it does not exist yet. True when this call created it. */
export function createLockFile(path: string, lock: OwnLock): Promise<boolean> {
  return createFileExclusive(path, JSON.stringify(lock));
}

/** True when the file at `path` is the one we created (same pid, token, run and start time). */
export async function isOurs(path: string, mine: OwnLock): Promise<boolean> {
  const text = await readTextIfExists(path);
  const current = text === undefined ? undefined : parseLockFile(text);
  return current !== undefined && sameLock(current, mine);
}
