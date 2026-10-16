import type { RunStore } from '../../ports/RunStore.js';
import type { Clock } from '../../shared/clock.js';
import { NotImplementedError } from '../../shared/errors.js';

export interface FsRunStoreOptions {
  /** Root data dir; runs live in <dataDir>/runs/<weekId>/, the lock in <dataDir>/. */
  dataDir: string;
  clock?: Clock;
}

/** Run history on disk (W1-13). */
export function createFsRunStore(_options: FsRunStoreOptions): RunStore {
  throw new NotImplementedError('W1-13');
}
