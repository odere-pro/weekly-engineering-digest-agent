// A run that stalled past the heartbeat timeout lost its lock; another run took it over and sent
// the week. When the first run wakes it must not send a second copy or replace the sent record.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDigest } from './runDigest';
import { KEPT_LOST_LOCK_REASON, KEPT_OTHER_RUN_REASON } from './ending/keepReason';
import { isUnretriable } from './ending/notes/unretriable';
import { NOW, WEEK, sentDigests, sentNotes, setup } from './__fixtures__/runKit';
import { ExitCode } from '../domain/schemas';
import type { DigestDeps, RunOptions } from './types';
import { createFsRunStore } from '../store/adapters/fsRunStore';
import { LOCK_HEARTBEAT_INTERVAL_MS } from '../store/adapters/lockState/lockTimings';
import { LOCK_FILE, weekDigestDir } from '../store/layout';
import type { RunStore } from '../store/RunStore';
import { fixedClock } from '../shared/clock';
import { makeRunRecord } from '../../test/builders';

/** Run A, parked in its first model call while `meanwhile` happens, as a frozen process is. */
async function runStalled(
  h: ReturnType<typeof setup>,
  meanwhile: () => void | Promise<void>,
  options: RunOptions = {},
  store: RunStore = h.store,
) {
  let wake!: () => void;
  const parked = new Promise<void>((resolve) => (wake = resolve));
  let reached!: () => void;
  const reachedGate = new Promise<void>((resolve) => (reached = resolve));
  let first = true;
  const model: DigestDeps['model'] = {
    health: () => h.model.health(),
    generate: (request) => h.model.generate(request),
    decide: async (request) => {
      if (first) {
        first = false;
        reached();
        await parked;
      }
      return h.model.decide(request);
    },
  };
  const pending = runDigest({ ...h.deps, model, store }, options);
  await reachedGate;
  await meanwhile();
  wake();
  return pending;
}

const otherRunSent = makeRunRecord({
  runId: WEEK,
  status: 'sent',
  deliveredTo: ['markdown', 'email'],
  sentUrls: ['https://example.com/other-run'],
  winner: 'the-other-run-writer',
});

/** Another run took the lock over and saved the week as sent while run A stalled. */
const otherRunSends = (h: ReturnType<typeof setup>) => (): void => {
  h.store.records.set(WEEK, otherRunSent);
};

describe('runDigest: the lock was lost to a run that delivered the week', () => {
  it('sends nothing and leaves the record of the run that sent the week', async () => {
    const h = setup();

    const result = await runStalled(h, otherRunSends(h));

    expect(sentDigests(h)).toEqual([]);
    expect(h.store.records.get(WEEK)).toBe(otherRunSent);
    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(result.kept).toBe(KEPT_OTHER_RUN_REASON);
    expect(result.record).toMatchObject({ status: 'failed', error: { step: 'deliver' } });
    expect(result.record.error?.message).toMatch(
      /^Run aborted before the deliver step: another run/,
    );
  });

  it('does not write its error.json over the files of the run that sent the week', async () => {
    const h = setup();
    h.store.artifacts.set(`${WEEK}/error.json`, '{"from":"nobody"}');

    await runStalled(h, otherRunSends(h));

    expect(h.artifact('error.json')).toBe('{"from":"nobody"}');
  });

  it('still reports it, even to a caller that holds notes back for a retry', async () => {
    const h = setup();

    const result = await runStalled(h, otherRunSends(h), {
      notifyFailure: false,
    });

    expect(isUnretriable(result.record.error?.message)).toBe(true);
    expect(sentNotes(h).map((note) => note.step)).toEqual(['deliver', 'deliver']);
  });

  it('delivers as usual when no other run delivered the week meanwhile', async () => {
    const h = setup();

    const result = await runStalled(h, () => undefined);

    expect(result.record.status).toBe('sent');
    expect(sentDigests(h)).toHaveLength(2);
    expect(result.kept).toBeUndefined();
  });

  it('keeps a quiet run from replacing the sent record, too', async () => {
    const h = setup({ relevance: () => 0 });

    const result = await runStalled(h, otherRunSends(h));

    expect(result.record.status).toBe('quiet');
    expect(result.kept).toBe(KEPT_OTHER_RUN_REASON);
    expect(h.store.records.get(WEEK)).toBe(otherRunSent);
  });
});

describe('runDigest: the lock was lost while the run stalled', () => {
  it('stops at the loss: no further file, no record, no digest, and it says so', async () => {
    const h = setup();

    const loseLock = (): void => {
      h.store.loseLock();
    };

    const result = await runStalled(h, loseLock, { notifyFailure: false });

    expect([...h.store.artifacts.keys()]).toEqual([`${WEEK}/items.json`]);
    expect(h.store.records.size).toBe(0);
    expect(sentDigests(h)).toEqual([]);
    expect(result.exitCode).toBe(ExitCode.Failed);
    expect(result.kept).toBe(KEPT_LOST_LOCK_REASON);
    expect(result.record.error?.message).toMatch(
      /^Run aborted during the classify step: this run lost its lock/,
    );
    expect(sentNotes(h).map((note) => note.step)).toEqual(['classify', 'classify']);
  });

  it('saves the record of a delivery it made before it saw the loss', async () => {
    const h = setup();
    const [first] = h.deliveries;
    if (!first) throw new Error('setup has channels');
    const send = first.sendDigest.bind(first);
    first.sendDigest = async (message) => {
      await send(message);
      h.store.loseLock();
    };

    const result = await h.run();

    expect(sentDigests(h)).toHaveLength(2);
    expect(result.kept).toBeUndefined();
    expect(h.store.records.get(WEEK)).toMatchObject({ status: 'sent' });
  });

  it('leaves a partly delivered week as it was when its resume lost the lock', async () => {
    const h = setup();
    const partly = makeRunRecord({ runId: WEEK, status: 'failed', deliveredTo: ['markdown'] });
    h.store.records.set(WEEK, partly);
    h.store.artifacts.set(`${WEEK}/digest.md`, '# Saved\n');
    const read = h.store.readArtifact.bind(h.store);
    h.store.readArtifact = (runId, name) => {
      h.store.loseLock();
      return read(runId, name);
    };

    const result = await h.run();

    expect(sentDigests(h)).toEqual([]);
    expect(result.kept).toBe(KEPT_LOST_LOCK_REASON);
    expect(h.store.records.get(WEEK)).toBe(partly);
  });
});

describe('runDigest on the file store: a contender took the lock over while the run stalled', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'lock-lost-'));
    // The beats are fired by hand, so the takeover lands between two of them.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('stops at its next beat and writes nothing after the loss', async () => {
    const h = setup();
    const disk = createFsRunStore({ dataDir, clock: h.deps.clock, logger: h.deps.logger });
    const writes: string[] = [];
    const store: RunStore = {
      ...disk,
      saveArtifact: (runId, name, content) => {
        writes.push(name);
        return disk.saveArtifact(runId, name, content);
      },
      saveRunRecord: (record) => {
        writes.push('run.json');
        return disk.saveRunRecord(record);
      },
      prune: (runId, keepWeeks) => {
        writes.push('prune');
        return disk.prune(runId, keepWeeks);
      },
    };
    // To a contender whose clock is 6 minutes ahead, the stalled run's heartbeat is stale.
    const sixMinutesLater = new Date(Date.parse(NOW) + 6 * 60_000).toISOString();
    const contender = createFsRunStore({ dataDir, clock: fixedClock(sixMinutesLater) });
    let writesBeforeLoss: string[] = [];
    let contenderLock = '';

    const result = await runStalled(
      h,
      async () => {
        await contender.acquireLock(WEEK);
        contenderLock = await readFile(join(dataDir, LOCK_FILE), 'utf8');
        writesBeforeLoss = [...writes];
        await vi.advanceTimersByTimeAsync(LOCK_HEARTBEAT_INTERVAL_MS);
        await vi.waitFor(() => {
          expect(h.logs.map((line) => line.message)).toContain(
            'Run lock is no longer ours (taken over or removed); this run stops',
          );
        });
      },
      {},
      store,
    );

    expect(writesBeforeLoss).toEqual(['items.json']);
    expect(writes).toEqual(writesBeforeLoss);
    expect(await readdir(weekDigestDir(dataDir, WEEK))).toEqual(['items.json']);
    expect(await readFile(join(dataDir, LOCK_FILE), 'utf8')).toBe(contenderLock);
    expect(sentDigests(h)).toEqual([]);
    expect(result.kept).toBe(KEPT_LOST_LOCK_REASON);
    expect(result.record.error?.message).toMatch(
      /^Run aborted during the classify step: this run lost its lock/,
    );
  });
});
