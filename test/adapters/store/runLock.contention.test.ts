import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Real processes, because in-process promises interleave too predictably to expose lock races.
const CONTENDERS = 4;
const ROUNDS = 40;
const ROUND_INTERVAL_MS = 40;
const STARTUP_GRACE_MS = 2500;
const MAX_ATTEMPTS = 3;
const CONTENDER_SCRIPT = fileURLToPath(new URL('./lockContender.ts', import.meta.url));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runlock-contention-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.error) throw child.error;
  return child.pid;
}

/** Per round: a stale lock alone ("stale"), and a stale lock plus an abandoned guard. */
async function seedStaleState(base: string): Promise<void> {
  const dead = JSON.stringify({
    pid: deadPid(),
    runId: '2026-W41',
    startedAt: new Date().toISOString(),
  });
  for (let round = 0; round < ROUNDS; round++) {
    for (const kind of ['stale', 'guarded']) {
      const dir = join(base, `${kind}-${String(round)}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'digest.lock'), dead);
      if (kind === 'guarded') await writeFile(join(dir, 'digest.lock.takeover'), dead);
    }
  }
}

function runContender(base: string, startAt: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [base, startAt, ROUNDS, ROUND_INTERVAL_MS, CONTENDERS].map(String);
    const child = spawn(process.execPath, ['--import', 'tsx', CONTENDER_SCRIPT, ...args], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`contender exited with ${String(code)}`));
    });
  });
}

/** Runs all contenders once. Returns the outcomes per round, or undefined if any started late. */
async function attempt(base: string, graceMs: number): Promise<Map<string, string[]> | undefined> {
  await seedStaleState(base);
  const startAt = Date.now() + graceMs;
  await Promise.all(Array.from({ length: CONTENDERS }, () => runContender(base, startAt)));

  const outcomes = new Map<string, string[]>();
  for (const name of await readdir(join(base, 'out'))) {
    if (name.startsWith('late-')) return undefined;
    const round = name.slice(0, name.lastIndexOf('-'));
    const outcome = await readFile(join(base, 'out', name), 'utf8');
    outcomes.set(round, [...(outcomes.get(round) ?? []), outcome]);
  }
  return outcomes;
}

describe('run lock under real process contention', () => {
  it('has exactly one winner per round for fresh, stale and guarded-stale locks', async () => {
    let outcomes: Map<string, string[]> | undefined;
    // On a loaded machine the children may miss the shared start time; retry with more slack
    // rather than pass without having raced.
    for (let i = 0; i < MAX_ATTEMPTS && outcomes === undefined; i++) {
      outcomes = await attempt(join(root, `attempt-${String(i)}`), STARTUP_GRACE_MS * 2 ** i);
    }
    if (outcomes === undefined) throw new Error('contenders kept missing the shared start time');

    expect(outcomes.size).toBe(ROUNDS * 3);
    const expected = ['lost', 'lost', 'lost', 'won'];
    for (const [round, results] of outcomes) {
      expect({ round, results: results.sort() }).toEqual({ round, results: expected });
    }
  }, 60_000);
});
