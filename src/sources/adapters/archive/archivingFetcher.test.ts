import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourceArchiving, type SourceArchivingOptions } from './archivingFetcher';
import { createSourceArchive, type SourceArchive } from './sourceArchive';
import type { Answer } from '../http';
import type { SourceTap } from '../pipeline';
import { createRssFetcher } from '../rss';
import type { FetchWindow, SourceFetcher } from '../../SourceFetcher';
import type { Item, Source } from '../../../domain/schemas';
import { noopLogger, type Logger } from '../../../shared/telemetry';
import { makeItem } from '../../../../test/builders';

const DAY = '2026-10-19';
const WINDOW: FetchWindow = {
  since: new Date('2026-10-12T00:00:00Z'),
  until: new Date('2026-10-19T00:00:00Z'),
  maxItems: 10,
};
const source = (id: string): Source => ({ id, kind: 'rss', url: `https://${id}.test/feed.xml` });
const answer = (body: string): Answer => ({
  url: 'https://x.test/feed.xml',
  status: 200,
  contentType: 'application/rss+xml',
  body,
});

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'archiving-fetcher-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** A fetcher that "answers" through the tap, then returns `result` after `delayMs`. */
function tappingFetcher(
  tap: SourceTap,
  result: (source: Source) => Item[] | Error,
  delayMs = 0,
): SourceFetcher {
  return {
    kind: 'rss',
    async fetch(src) {
      tap.answer?.({ sourceId: src.id, ...answer(`<rss>${src.id}</rss>`) });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const value = result(src);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function archiving(overrides: Partial<SourceArchivingOptions> = {}) {
  return createSourceArchiving({
    archive: createSourceArchive({ dataDir }),
    day: () => DAY,
    logger: noopLogger,
    ...overrides,
  });
}

const read = (...path: string[]): Promise<string> => readFile(join(dataDir, DAY, ...path), 'utf8');

describe('createSourceArchiving', () => {
  it('saves the answers and the items of a fetch in the day folder, and returns the items', async () => {
    const archive = archiving();
    const items = [makeItem({ sourceId: 'a' })];
    const fetcher = archive.wrap(tappingFetcher(archive.tap, () => items));

    await expect(fetcher.fetch(source('a'), WINDOW)).resolves.toEqual(items);
    await archive.flush();

    await expect(read('a', 'raw', 'response-1.xml')).resolves.toBe('<rss>a</rss>');
    expect(JSON.parse(await read('a', 'formatted', 'items.json'))).toEqual(items);
    expect(fetcher.kind).toBe('rss');
  });

  it('returns the items before the save is done, so a slow disk never eats the fetch timeout', async () => {
    let finishSave: () => void = () => undefined;
    const save = vi.fn<SourceArchive['save']>(
      () =>
        new Promise((resolve) => {
          finishSave = () => {
            resolve({ raw: [] });
          };
        }),
    );
    const archive = archiving({ archive: { save } });
    const items = [makeItem()];
    const fetcher = archive.wrap(tappingFetcher(archive.tap, () => items));

    await expect(fetcher.fetch(source('a'), WINDOW)).resolves.toEqual(items);
    expect(save).toHaveBeenCalledOnce();

    let flushed = false;
    const flushing = archive.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(flushed).toBe(false);
    finishSave();
    await flushing;
    expect(flushed).toBe(true);
  });

  it('keeps concurrent fetches apart: each source gets only its own answers', async () => {
    const archive = archiving();
    const fetcher = archive.wrap(tappingFetcher(archive.tap, () => [], 5));

    await Promise.all(['a', 'b', 'c'].map((id) => fetcher.fetch(source(id), WINDOW)));
    await archive.flush();

    for (const id of ['a', 'b', 'c']) {
      await expect(readdir(join(dataDir, DAY, id, 'raw'))).resolves.toEqual([
        'response-1.xml',
        'responses.json',
      ]);
      await expect(read(id, 'raw', 'response-1.xml')).resolves.toBe(`<rss>${id}</rss>`);
    }
  });

  it('saves the answers of a failed fetch, then rethrows its error', async () => {
    const archive = archiving();
    const boom = new Error('feed broke');
    const fetcher = archive.wrap(tappingFetcher(archive.tap, () => boom));

    await expect(fetcher.fetch(source('a'), WINDOW)).rejects.toBe(boom);
    await archive.flush();

    await expect(readdir(join(dataDir, DAY, 'a'))).resolves.toEqual(['raw']);
  });

  it('keeps the newer attempt when an attempt the collect step gave up on settles after it', async () => {
    const archive = archiving();
    let releaseFirst: (items: Item[]) => void = () => undefined;
    const first = new Promise<Item[]>((resolve) => {
      releaseFirst = resolve;
    });
    const newer = [makeItem({ title: 'from the retry' })];
    let calls = 0;
    const fetcher = archive.wrap({
      kind: 'rss',
      fetch: async () => {
        calls += 1;
        return calls === 1 ? first : newer;
      },
    });

    const timedOut = fetcher.fetch(source('a'), WINDOW);
    await expect(fetcher.fetch(source('a'), WINDOW)).resolves.toEqual(newer);
    releaseFirst([makeItem({ title: 'stale' })]);
    await timedOut;
    await archive.flush();

    expect(JSON.parse(await read('a', 'formatted', 'items.json'))).toEqual(newer);
  });

  it('saves the attempts of one source one after the other, the last one last', async () => {
    const order: string[] = [];
    const save = vi.fn<SourceArchive['save']>(async (_day, _sourceId, recording) => {
      const label = recording.items?.[0]?.title ?? 'none';
      order.push(`start ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end ${label}`);
      return { raw: [] };
    });
    const archive = archiving({ archive: { save } });
    let calls = 0;
    const fetcher = archive.wrap({
      kind: 'rss',
      fetch: () => {
        calls += 1;
        return Promise.resolve([makeItem({ title: `attempt ${String(calls)}` })]);
      },
    });

    await fetcher.fetch(source('a'), WINDOW);
    await fetcher.fetch(source('a'), WINDOW);
    await archive.flush();

    expect(order).toEqual(['start attempt 1', 'end attempt 1', 'start attempt 2', 'end attempt 2']);
  });

  it('archives nothing outside a run', async () => {
    const save = vi.fn<SourceArchive['save']>();
    const archive = archiving({ archive: { save }, day: () => undefined });
    const fetcher = archive.wrap(tappingFetcher(archive.tap, () => []));

    await expect(fetcher.fetch(source('a'), WINDOW)).resolves.toEqual([]);
    await archive.flush();
    expect(save).not.toHaveBeenCalled();
  });

  it('fetches without saving, and warns once, when the day folder cannot be told', async () => {
    const warn = vi.fn<Logger['warn']>();
    const save = vi.fn<SourceArchive['save']>();
    const archive = archiving({
      archive: { save },
      day: () => {
        throw new Error('Invalid run id "x"');
      },
      logger: { ...noopLogger, warn },
    });
    const items = [makeItem()];
    const fetcher = archive.wrap(tappingFetcher(archive.tap, () => items));

    await expect(fetcher.fetch(source('a'), WINDOW)).resolves.toEqual(items);
    await expect(fetcher.fetch(source('b'), WINDOW)).resolves.toEqual(items);
    await archive.flush();

    expect(save).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Fetched data is not saved: the day folder of the run is unknown',
      { error: 'Invalid run id "x"' },
    );
  });

  it('logs a failed save as a warning and still returns the items', async () => {
    const warn = vi.fn<Logger['warn']>();
    const archive = archiving({
      archive: { save: () => Promise.reject(new Error('disk full')) },
      logger: { ...noopLogger, warn },
    });
    const items = [makeItem()];
    const fetcher = archive.wrap(tappingFetcher(archive.tap, () => items));

    await expect(fetcher.fetch(source('a'), WINDOW)).resolves.toEqual(items);
    await expect(archive.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Could not save the fetched data of a source', {
      sourceId: 'a',
      error: 'disk full',
    });
  });

  it('records the raw feed a real fetcher read, through its tap', async () => {
    const archive = archiving();
    const feed =
      '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>' +
      '<item><title>One</title><link>https://a.test/1</link>' +
      '<pubDate>Wed, 14 Oct 2026 10:00:00 GMT</pubDate><description>Hi</description></item>' +
      '</channel></rss>';
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(feed, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
      ),
    );
    const fetcher = archive.wrap(createRssFetcher({ fetch: fakeFetch, tap: archive.tap }));

    const items = await fetcher.fetch({ ...source('a'), url: 'https://a.test/feed.xml' }, WINDOW);
    await archive.flush();

    expect(items.map((item) => item.title)).toEqual(['One']);
    await expect(read('a', 'raw', 'response-1.xml')).resolves.toBe(feed);
  });
});
