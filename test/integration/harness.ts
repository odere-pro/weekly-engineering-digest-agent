// Compat (W10-B26): the shared kit now lives in `./harness/`, one file per thing it builds.
// Only `src/scheduler/scheduler.runDigest.test.ts`, outside test/integration, still imports this
// path; remove these lines when it imports from the files below.
export { FRIDAY, TEST_TIMEOUT_MS, WEEK } from './harness/constants'; // compat (W10-B26)
export { useDataDir } from './harness/dataDir'; // compat (W10-B26)
export { lockExists, writeLock } from './harness/lock'; // compat (W10-B26)
export { readRunJson, runFile } from './harness/runFiles'; // compat (W10-B26)
export { createWorld, type World } from './harness/world'; // compat (W10-B26)
