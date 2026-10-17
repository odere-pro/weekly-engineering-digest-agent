// Spec phase 4 exit gate, part 3: a run is safe to repeat. The lock, the sent-week skip and
// --force, on the real run store and the real lock file in a temp dir.
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runDigest } from '../../src/core/runDigest.js';
import { KEPT_SENT_REASON } from '../../src/core/runEnding.js';
import { ExitCode } from '../../src/core/schemas.js';
import type { ModelProvider } from '../../src/ports/ModelProvider.js';
import {
  TEST_TIMEOUT_MS,
  FRIDAY,
  LOCK_FILE,
  WEEK,
  createWorld,
  deadPid,
  lockExists,
  readRunJson,
  readTextIfExists,
  runCli,
  runFile,
  useDataDir,
  withModel,
  writeLock,
  type LockContents,
  type World,
} from './harness.js';

const dataDir = useDataDir();

const digestsSent = (world: World): number[] => world.deliveries.map((d) => d.digests.length);
const runJsonText = (): Promise<string | undefined> =>
  readTextIfExists(runFile(dataDir(), WEEK, 'run.json'));

describe('integration: a held lock', () => {
  it('refuses to start while a live run holds the lock: exit 1 with a message', async () => {
    const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
    await writeLock(dataDir(), { pid: process.pid, runId: WEEK, startedAt: FRIDAY });

    const cli = await runCli(world);

    expect(cli.exitCode).toBe(ExitCode.Failed);
    expect(cli.stderr).toContain(`Another run is in progress (pid ${process.pid}, week ${WEEK})`);
    expect(world.rss.calls).toEqual([]);
    expect(world.fake.decideCalls).toEqual([]);
    expect(digestsSent(world)).toEqual([0, 0, 0]);
    expect(await runJsonText()).toBeUndefined();
    // The other run's lock is not ours to remove.
    expect(await lockExists(dataDir())).toBe(true);
  });
});

describe('integration: a stale lock', () => {
  const staleLocks: [string, () => LockContents | string, string][] = [
    [
      'its process is gone',
      () => ({ pid: deadPid(), runId: '2026-W41', startedAt: FRIDAY }),
      'process is not running',
    ],
    [
      'it is over six hours old',
      () => ({ pid: process.pid, runId: '2026-W41', startedAt: '2026-10-15T20:00:00Z' }),
      'lock is too old',
    ],
    ['it is unreadable', () => 'half-written', 'lock file is unreadable'],
  ];

  it.each(staleLocks)(
    'takes the lock over and runs the week when %s',
    async (_name, make, reason) => {
      const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
      await writeLock(dataDir(), make());

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Sent);
      expect(digestsSent(world)).toEqual([1, 1, 1]);
      const takeover = world.logs.find((line) => line.message === 'Taking over stale run lock');
      expect(takeover?.level).toBe('warn');
      expect(takeover?.fields).toMatchObject({ reason });
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'also clears a takeover guard that a crashed run left behind',
    async () => {
      const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
      const abandoned: LockContents = { pid: deadPid(), runId: '2026-W41', startedAt: FRIDAY };
      await writeLock(dataDir(), abandoned);
      await writeFile(join(dataDir(), `${LOCK_FILE}.takeover`), JSON.stringify(abandoned));

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Sent);
      const messages = world.logs.map((line) => line.message);
      expect(messages).toContain('Removing abandoned lock takeover guard');
      expect(messages).toContain('Taking over stale run lock');
      expect(await lockExists(dataDir())).toBe(false);
      expect(await readTextIfExists(join(dataDir(), `${LOCK_FILE}.takeover`))).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('integration: an old takeover guard', () => {
  it(
    'clears a guard that is over 30 s old even when its process is alive',
    async () => {
      const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
      const gone: LockContents = { pid: deadPid(), runId: '2026-W41', startedAt: FRIDAY };
      const stuck: LockContents = {
        pid: process.pid,
        runId: '2026-W41',
        startedAt: '2026-10-16T05:44:00Z',
      };
      await writeLock(dataDir(), gone);
      await writeFile(join(dataDir(), `${LOCK_FILE}.takeover`), JSON.stringify(stuck));

      const result = await runDigest(world.deps);

      expect(result.exitCode).toBe(ExitCode.Sent);
      const warning = world.logs.find(
        (line) => line.message === 'Removing abandoned lock takeover guard',
      );
      expect(warning?.fields).toMatchObject({ reason: 'lock is too old' });
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('integration: running a week twice', () => {
  it(
    'skips a week that already has a sent digest and leaves its record alone',
    async () => {
      const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
      await runDigest(world.deps);
      const recordBefore = await runJsonText();
      const callsBefore = {
        feeds: world.rss.calls.length + world.github.calls.length,
        decide: world.fake.decideCalls.length,
        generate: world.fake.generateCalls.length,
      };

      const again = await runCli(world);

      expect(again.exitCode).toBe(ExitCode.Sent);
      expect(again.stdout).toContain('Status    skipped');
      expect(again.stdout).toContain('Use --force to run it again');
      expect(digestsSent(world)).toEqual([1, 1, 1]);
      for (const delivery of world.deliveries) expect(delivery.failures).toEqual([]);
      expect(await runJsonText()).toBe(recordBefore);
      expect({
        feeds: world.rss.calls.length + world.github.calls.length,
        decide: world.fake.decideCalls.length,
        generate: world.fake.generateCalls.length,
      }).toEqual(callsBefore);
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'runs a sent week again and sends it again with --force',
    async () => {
      const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
      await runDigest(world.deps);

      const forced = await runCli(world, { force: true });

      expect(forced.exitCode).toBe(ExitCode.Sent);
      expect(forced.stdout).toContain('Status    sent');
      expect(digestsSent(world)).toEqual([2, 2, 2]);
      const record = await readRunJson(dataDir(), WEEK);
      expect(record.status).toBe('sent');
      expect(record.sentUrls).toHaveLength(3);
      expect(await lockExists(dataDir())).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the sent record when a forced rerun fails, so the week is not sent a third time',
    async () => {
      const world = createWorld({ now: FRIDAY, dataDir: dataDir() });
      await runDigest(world.deps);
      const recordBefore = await runJsonText();
      const ollamaDown: ModelProvider = {
        generate: () => Promise.reject(new Error('Ollama is down')),
        decide: () => Promise.reject(new Error('Ollama is down')),
        health: () =>
          Promise.resolve({ reachable: false, models: [], error: 'connection refused' }),
      };

      const forced = await runDigest(withModel(world, ollamaDown), { force: true });

      expect(forced.exitCode).toBe(ExitCode.Failed);
      expect(forced.record.status).toBe('failed');
      expect(await runJsonText()).toBe(recordBefore);
      expect(await world.store.hasSentDigest(WEEK)).toBe(true);
      expect(forced.kept).toBe(KEPT_SENT_REASON);
      expect(world.logs.map((line) => line.message)).toContain(KEPT_SENT_REASON);
      expect(digestsSent(world)).toEqual([1, 1, 1]);
      // The failure is still reported to every channel.
      for (const delivery of world.deliveries) {
        expect(delivery.failures).toEqual([
          {
            weekId: WEEK,
            message: 'Ollama is not reachable: connection refused. Start Ollama and run again.',
          },
        ]);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
