// Child process for runLock.contention.test.ts: races other copies of itself for the run lock.
// Usage: node --import tsx lockContender.ts <baseDir> <startAtMs> <rounds> <intervalMs> <contenders>
// Each round r targets <baseDir>/<kind>-r for every kind below and records "won", "lost" or
// "error: ..." in <baseDir>/out. Locks are never released: winners must keep holding them.
// A child that reaches the starting line after <startAtMs> leaves a "late-<pid>" marker, so the
// test can tell that the processes did not really start together.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFsRunStore } from '../../../src/adapters/store/fsRunStore.js';
import { DigestError, errorMessage } from '../../../src/shared/errors.js';

const KINDS = ['fresh', 'stale', 'guarded'];

const [baseDir, startAt, rounds, intervalMs, contenders] = process.argv.slice(2);
if (!baseDir || !startAt || !rounds || !intervalMs || !contenders) {
  throw new Error('missing arguments');
}

function spinUntil(timestamp: number): void {
  while (Date.now() < timestamp) {
    // Busy-wait: every contender must leave the starting line within the same millisecond.
  }
}

async function race(dataDir: string): Promise<string> {
  try {
    await createFsRunStore({ dataDir }).acquireLock('2026-W42');
    return 'won';
  } catch (error) {
    return error instanceof DigestError ? 'lost' : `error: ${errorMessage(error)}`;
  }
}

const outDir = join(baseDir, 'out');
mkdirSync(outDir, { recursive: true });
if (Date.now() >= Number(startAt)) writeFileSync(join(outDir, `late-${String(process.pid)}`), '');

for (let round = 0; round < Number(rounds); round++) {
  spinUntil(Number(startAt) + round * Number(intervalMs));
  for (const kind of KINDS) {
    const outcome = await race(join(baseDir, `${kind}-${String(round)}`));
    writeFileSync(join(outDir, `${kind}-${String(round)}-${String(process.pid)}`), outcome);
  }
}

// A winner that exits early leaves a dead-pid lock that a slower contender may rightly take over,
// so nobody leaves until everybody has finished.
const doneDir = join(baseDir, 'done');
mkdirSync(doneDir, { recursive: true });
writeFileSync(join(doneDir, String(process.pid)), '');
const deadline = Date.now() + 20_000;
while (readdirSync(doneDir).length < Number(contenders) && Date.now() < deadline) {
  await sleep(10);
}
