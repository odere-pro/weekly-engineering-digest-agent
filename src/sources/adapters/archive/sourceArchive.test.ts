import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSourceArchive, rawExtension } from './sourceArchive';
import type { Answer } from '../http';
import { makeItem } from '../../../../test/builders';

const DAY = '2026-10-19';

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'source-archive-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const feed: Answer = {
  url: 'https://openai.com/news/rss.xml',
  status: 200,
  contentType: 'application/rss+xml; charset=utf-8',
  body: '<rss><channel/></rss>',
};

const sourceDir = (sourceId: string, part: string): string => join(dataDir, DAY, sourceId, part);

describe('createSourceArchive', () => {
  it('writes each answer to raw/ and the items to formatted/items.json', async () => {
    const items = [makeItem({ sourceId: 'openai-news' })];
    const saved = await createSourceArchive({ dataDir }).save(DAY, 'openai-news', {
      answers: [feed],
      items,
    });

    await expect(
      readFile(join(sourceDir('openai-news', 'raw'), 'response-1.xml'), 'utf8'),
    ).resolves.toBe(feed.body);
    const formatted = await readFile(
      join(sourceDir('openai-news', 'formatted'), 'items.json'),
      'utf8',
    );
    expect(JSON.parse(formatted)).toEqual(items);
    expect(saved).toEqual({
      raw: ['openai-news/raw/response-1.xml'],
      formatted: 'openai-news/formatted/items.json',
    });
  });

  it('lists every answer, with or without a body, in raw/responses.json', async () => {
    const notFound: Answer = {
      url: 'https://openai.com/x',
      status: 404,
      contentType: undefined,
      body: '',
    };
    await createSourceArchive({ dataDir }).save(DAY, 'openai-news', {
      answers: [notFound, feed],
      items: [],
    });

    const index = JSON.parse(
      await readFile(join(sourceDir('openai-news', 'raw'), 'responses.json'), 'utf8'),
    ) as unknown;
    expect(index).toEqual([
      { file: null, url: notFound.url, status: 404, contentType: null },
      { file: 'response-2.xml', url: feed.url, status: 200, contentType: feed.contentType },
    ]);
  });

  it('keeps the query string and fragment of a URL out of responses.json', async () => {
    await createSourceArchive({ dataDir }).save(DAY, 'openai-news', {
      answers: [{ ...feed, url: 'https://openai.com/rss.xml?key=abc123#top' }],
      items: [],
    });

    const index = await readFile(join(sourceDir('openai-news', 'raw'), 'responses.json'), 'utf8');
    expect(index).toContain('"url": "https://openai.com/rss.xml"');
    expect(index).not.toContain('abc123');
  });

  it('replaces what an earlier fetch of the same day left', async () => {
    const archive = createSourceArchive({ dataDir });
    await archive.save(DAY, 'openai-news', { answers: [feed, feed], items: [] });
    await archive.save(DAY, 'openai-news', { answers: [feed], items: [] });

    await expect(readdir(sourceDir('openai-news', 'raw'))).resolves.toEqual([
      'response-1.xml',
      'responses.json',
    ]);
  });

  it('removes the formatted items of an earlier fetch when this one failed', async () => {
    const archive = createSourceArchive({ dataDir });
    await archive.save(DAY, 'openai-news', { answers: [feed], items: [makeItem()] });
    const saved = await archive.save(DAY, 'openai-news', { answers: [feed] });

    await expect(readdir(join(dataDir, DAY, 'openai-news'))).resolves.toEqual(['raw']);
    expect(saved.formatted).toBeUndefined();
  });

  it('runs every text it writes through redact', async () => {
    const archive = createSourceArchive({
      dataDir,
      redact: (text) => text.replaceAll('s3cret', '[REDACTED]'),
    });
    await archive.save(DAY, 'gh', {
      answers: [{ ...feed, url: 'https://x.test/?t=s3cret', body: '<rss>s3cret</rss>' }],
      items: [makeItem({ title: 'leaks s3cret' })],
    });

    const files = await Promise.all(
      [
        join(sourceDir('gh', 'raw'), 'response-1.xml'),
        join(sourceDir('gh', 'raw'), 'responses.json'),
        join(sourceDir('gh', 'formatted'), 'items.json'),
      ].map((path) => readFile(path, 'utf8')),
    );
    for (const text of files) expect(text).not.toContain('s3cret');
  });

  it('refuses a source id that is not a plain folder name, writing nothing', async () => {
    await expect(
      createSourceArchive({ dataDir }).save(DAY, '../escape', { answers: [feed], items: [] }),
    ).rejects.toThrow(/source id/);
    await expect(readdir(dataDir)).resolves.toEqual([]);
  });

  it('leaves the other sources of the day alone', async () => {
    await mkdir(sourceDir('other', 'raw'), { recursive: true });
    await writeFile(join(sourceDir('other', 'raw'), 'keep.xml'), 'x');
    await createSourceArchive({ dataDir }).save(DAY, 'openai-news', { answers: [feed], items: [] });

    await expect(readdir(sourceDir('other', 'raw'))).resolves.toEqual(['keep.xml']);
  });
});

describe('rawExtension', () => {
  it.each([
    ['application/json', '{}', 'json'],
    ['text/html; charset=utf-8', '<p>', 'html'],
    ['application/atom+xml', '<feed>', 'xml'],
    [undefined, '  [1]', 'json'],
    [undefined, '<!DOCTYPE html><html>', 'html'],
    [undefined, '<?xml version="1.0"?>', 'xml'],
    [undefined, 'plain text', 'html'],
  ] as const)('reads %s / %j as %s', (contentType, body, extension) => {
    expect(rawExtension({ contentType, body })).toBe(extension);
  });
});
