import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readTextIfExists } from '../../../src/shared/atomicFile';

export const LOCK_FILE = 'digest.lock';

export async function lockExists(dataDir: string): Promise<boolean> {
  return (await readTextIfExists(join(dataDir, LOCK_FILE))) !== undefined;
}

export interface LockContents {
  pid: number;
  runId: string;
  startedAt: string;
}

export async function writeLock(dataDir: string, lock: LockContents | string): Promise<void> {
  const text = typeof lock === 'string' ? lock : JSON.stringify(lock);
  await writeFile(join(dataDir, LOCK_FILE), text);
}

/** The pid of a process that has already exited. */
export function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.error) throw child.error;
  return child.pid;
}
