// A run.json this build cannot parse (written by a newer build, then rolled back) must not make a
// week that was sent look unsent: catch-up would send it again and its links would leave dedupe.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createFsRunStore } from './fsRunStore';
import { weekDigestDir } from '../layout';
import type { RunStore } from '../RunStore';
import { fixedClock } from '../../shared/clock';
import { noopLogger, type Logger } from '../../shared/telemetry';
import { makeRunRecord } from '../../../test/builders';

let root: string;
let dataDir: string;
let warn: Mock<Logger['warn']>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fsrunstore-unreadable-'));
  dataDir = join(root, 'data');
  warn = vi.fn<Logger['warn']>();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeStore(): RunStore {
  const logger: Logger = { ...noopLogger, warn, child: () => logger };
  return createFsRunStore({ dataDir, clock: fixedClock('2026-10-19T08:00:00.000Z'), logger });
}

/** Writes a run.json as a build that knows a channel this one lacks would have. */
async function writeRunJson(runId: string, overrides: Record<string, unknown>): Promise<void> {
  const dir = weekDigestDir(dataDir, runId);
  await mkdir(dir, { recursive: true });
  const record = { ...makeRunRecord({ runId }), ...overrides };
  await writeFile(join(dir, 'run.json'), JSON.stringify(record));
}

const NEWER_CHANNELS = ['markdown', 'email', 'teams'];

describe('a run.json this build cannot parse', () => {
  it('still reads as undefined from getRunRecord, with the warning', async () => {
    await writeRunJson('2026-W42', { status: 'sent', deliveredTo: NEWER_CHANNELS });

    await expect(makeStore().getRunRecord('2026-W42')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Ignoring unreadable run.json',
      expect.objectContaining({ runId: '2026-W42' }),
    );
  });

  it('is still a sent week for hasSentDigest', async () => {
    await writeRunJson('2026-W42', { status: 'sent', deliveredTo: NEWER_CHANNELS });

    await expect(makeStore().hasSentDigest('2026-W42')).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is not a sent week when its status is not sent', async () => {
    await writeRunJson('2026-W42', { status: 'failed', deliveredTo: NEWER_CHANNELS });

    await expect(makeStore().hasSentDigest('2026-W42')).resolves.toBe(false);
  });

  it('still counts the urls of a sent week for the dedupe of the next one', async () => {
    await writeRunJson('2026-W41', {
      status: 'sent',
      deliveredTo: NEWER_CHANNELS,
      sentUrls: ['https://example.com/last-week'],
    });

    const urls = await makeStore().sentUrls('2026-W42', 2);

    expect([...urls]).toEqual(['https://example.com/last-week']);
  });

  it('counts the urls of a partly delivered week, as a readable one does', async () => {
    await writeRunJson('2026-W41', {
      status: 'failed',
      deliveredTo: ['teams'],
      sentUrls: ['https://example.com/partial'],
    });

    expect([...(await makeStore().sentUrls('2026-W42', 2))]).toEqual([
      'https://example.com/partial',
    ]);
  });

  it('counts no url of a failed week that reached no channel', async () => {
    await writeRunJson('2026-W41', {
      status: 'failed',
      deliveredTo: [],
      sentUrls: ['https://example.com/none'],
    });

    expect((await makeStore().sentUrls('2026-W42', 2)).size).toBe(0);
  });

  it('counts a sent week whose record also lacks fields this build requires', async () => {
    const dir = weekDigestDir(dataDir, '2026-W41');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'run.json'),
      JSON.stringify({
        runId: '2026-W41',
        status: 'sent',
        sentUrls: ['https://example.com/minimal'],
      }),
    );

    const store = makeStore();

    await expect(store.hasSentDigest('2026-W41')).resolves.toBe(true);
    expect([...(await store.sentUrls('2026-W42', 2))]).toEqual(['https://example.com/minimal']);
  });

  it('is not trusted when it belongs to another week', async () => {
    await writeRunJson('2026-W42', {
      runId: '2026-W41',
      status: 'sent',
      deliveredTo: NEWER_CHANNELS,
    });

    await expect(makeStore().hasSentDigest('2026-W42')).resolves.toBe(false);
  });

  it.each([
    ['not json', '{ not json'],
    ['a json array', '[]'],
    ['a status that is not text', JSON.stringify({ runId: '2026-W42', status: 7 })],
    ['no status', JSON.stringify({ runId: '2026-W42', sentUrls: [] })],
    [
      'a url list that is not a list',
      JSON.stringify({ runId: '2026-W42', status: 'sent', sentUrls: 'x' }),
    ],
  ])('stays a week that was not sent when run.json is %s', async (_name, content) => {
    const dir = weekDigestDir(dataDir, '2026-W42');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run.json'), content);

    const store = makeStore();

    await expect(store.hasSentDigest('2026-W42')).resolves.toBe(false);
    expect((await store.sentUrls('2026-W43', 2)).size).toBe(0);
  });
});
