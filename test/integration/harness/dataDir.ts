import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/**
 * A fresh data dir for each test, removed afterwards. Call it once at the top of a test file
 * (or a `describe`) and read the path inside a test; reading it earlier throws.
 */
export function useDataDir(): () => string {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'digest-int-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return () => {
    if (dir === '') throw new Error('The data dir exists only while a test runs');
    return dir;
  };
}
