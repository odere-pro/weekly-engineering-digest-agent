import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIN_SUMMARY_CHARS,
  SOURCE_ALLOWED_HOSTS,
  conformanceProblems,
  evaluateSources,
  fetchFromRecording,
  loadSourceRecordings,
  type SourceFetcherFactories,
  type SourceRecording,
} from '../../evals/sourceEval.js';
import type { Item, Source } from '../../src/core/schemas.js';
import { itemIdFor } from '../../src/shared/url.js';
import { makeItem } from '../builders.js';
import { FakeSourceFetcher } from '../fakes/FakeSourceFetcher.js';

const LONG = 'A summary that is comfortably longer than forty characters.';

const feedA: Source = { id: 'feed-a', kind: 'rss', url: 'https://openai.com/news/rss.xml' };
const repoB: Source = { id: 'repo-b', kind: 'github', url: 'https://github.com/ollama/ollama' };

function goodItem(sourceId: string, n: number, overrides: Partial<Item> = {}): Item {
  const url = `https://openai.com/news/post-${n}`;
  return makeItem({
    id: itemIdFor(url),
    sourceId,
    url,
    title: `Post ${n}`,
    summary: LONG,
    publishedAt: '2026-10-12T09:00:00.000Z',
    ...overrides,
  });
}

function recording(
  source: Source,
  expectedItems: Item[],
  overrides: Partial<SourceRecording['expected']> = {},
): SourceRecording {
  return {
    source,
    response: {
      url: source.url,
      status: 200,
      contentType: 'application/xml',
      fetchedAt: '2026-10-17T08:00:00.000Z',
      bodyFile: 'body.xml',
    },
    body: '<rss/>',
    expected: {
      reviewed: true,
      entryCount: expectedItems.length,
      items: expectedItems,
      knownGaps: [],
      ...overrides,
    },
  };
}

function factoriesFor(
  byKind: Partial<Record<'rss' | 'github', Record<string, Item[] | Error>>>,
): SourceFetcherFactories {
  return {
    rss: () => new FakeSourceFetcher('rss', byKind.rss ?? {}),
    github: () => new FakeSourceFetcher('github', byKind.github ?? {}),
  };
}

describe('evaluateSources', () => {
  it('counts a clean source as fully parsed with no defects', async () => {
    const items = [goodItem('feed-a', 1), goodItem('feed-a', 2)];
    const [result] = await evaluateSources(
      [recording(feedA, items)],
      factoriesFor({ rss: { 'feed-a': items } }),
    );

    expect(result).toEqual({
      sourceId: 'feed-a',
      parsed: 2,
      expected: 2,
      schemaInvalid: 0,
      emptyTitle: 0,
      emptySummary: 0,
      badDate: 0,
      idMismatch: 0,
      hostOutsideAllowlist: 0,
    });
  });

  it('counts every kind of defect on the items a fetcher returns', async () => {
    const expected = [1, 2, 3, 4, 5, 6].map((n) => goodItem('repo-b', n));
    const returned: Item[] = [
      goodItem('repo-b', 1, { title: '  ' }),
      goodItem('repo-b', 2, { summary: 'x'.repeat(MIN_SUMMARY_CHARS - 1) }),
      goodItem('repo-b', 3, { publishedAt: 'last Tuesday' }),
      goodItem('repo-b', 4, { id: 'not-the-hash' }),
      goodItem('repo-b', 5, {
        url: 'https://evil.example.net/x',
        id: itemIdFor('https://evil.example.net/x'),
      }),
      goodItem('repo-b', 6, { url: 'not a url' }),
    ];
    const [result] = await evaluateSources(
      [recording(repoB, expected)],
      factoriesFor({ github: { 'repo-b': returned } }),
    );

    expect(result).toMatchObject({
      sourceId: 'repo-b',
      parsed: 6,
      expected: 6,
      emptyTitle: 1,
      emptySummary: 1,
      badDate: 1,
      idMismatch: 2, // item 4, and item 6 whose url is not a url
      hostOutsideAllowlist: 2, // item 5, and item 6 whose host cannot be read
    });
    expect(result?.schemaInvalid).toBe(2); // the bad date and the bad url
  });

  it('records a fetcher that throws as zero parsed items with the reason', async () => {
    const [result] = await evaluateSources(
      [recording(feedA, [goodItem('feed-a', 1)])],
      factoriesFor({ rss: { 'feed-a': new Error('Cannot parse feed feed-a') } }),
    );

    expect(result).toMatchObject({ parsed: 0, expected: 1, error: 'Cannot parse feed feed-a' });
  });

  it('runs the fetcher of the source kind over each recording', async () => {
    const results = await evaluateSources(
      [
        recording(feedA, [goodItem('feed-a', 1)]),
        recording(repoB, [goodItem('repo-b', 2), goodItem('repo-b', 3)]),
      ],
      factoriesFor({
        rss: { 'feed-a': [goodItem('feed-a', 1)] },
        github: { 'repo-b': [goodItem('repo-b', 2)] },
      }),
    );

    expect(results.map((r) => [r.sourceId, r.parsed, r.expected])).toEqual([
      ['feed-a', 1, 1],
      ['repo-b', 1, 2],
    ]);
  });
});

describe('fetchFromRecording', () => {
  it('hands the fetcher a fetch that serves the recorded status, type and body', async () => {
    let seen: { status: number; type: string | null; body: string; url: string } | undefined;
    const factories: SourceFetcherFactories = {
      rss: (serve) => ({
        kind: 'rss',
        async fetch(source) {
          const response = await serve(source.url);
          seen = {
            status: response.status,
            type: response.headers.get('content-type'),
            body: await response.text(),
            url: source.url,
          };
          return [];
        },
      }),
      github: () => new FakeSourceFetcher('github', {}),
    };

    await fetchFromRecording(recording(feedA, []), factories);

    expect(seen).toEqual({
      status: 200,
      type: 'application/xml',
      body: '<rss/>',
      url: feedA.url,
    });
  });

  it('asks for a window that covers every entry and the largest cap', async () => {
    const fake = new FakeSourceFetcher('rss', {});
    await fetchFromRecording(recording(feedA, []), { rss: () => fake, github: () => fake });

    const { window } = fake.calls[0]!;
    expect(window.maxItems).toBe(100);
    expect(window.since.getTime()).toBeLessThanOrEqual(Date.parse('1990-01-01'));
    expect(window.until.getTime()).toBeGreaterThanOrEqual(Date.parse('2100-01-01'));
  });
});

describe('conformanceProblems', () => {
  const expected = [goodItem('feed-a', 1), goodItem('feed-a', 2)];

  it('is empty when the items match', () => {
    expect(conformanceProblems(expected, expected, [])).toEqual([]);
  });

  it('names a missing, an extra and a changed item', () => {
    const actual = [goodItem('feed-a', 1, { title: 'Changed' }), goodItem('feed-a', 3)];
    const problems = conformanceProblems(actual, expected, []);

    expect(problems.join('\n')).toMatch(/missing .*post-2/);
    expect(problems.join('\n')).toMatch(/unexpected .*post-3/);
    expect(problems.join('\n')).toMatch(/title/);
  });

  it('compares dates and urls too', () => {
    const actual = [
      goodItem('feed-a', 1, { publishedAt: '2026-10-13T09:00:00.000Z' }),
      goodItem('feed-a', 2),
    ];
    expect(conformanceProblems(actual, expected, []).join('\n')).toMatch(/publishedAt/);
  });

  it('compares summaries unless the source has a known summary gap', () => {
    const actual = expected.map((item) => ({ ...item, summary: '' }));

    expect(conformanceProblems(actual, expected, []).join('\n')).toMatch(/summary/);
    expect(conformanceProblems(actual, expected, ['summary'])).toEqual([]);
  });
});

describe('loadSourceRecordings', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'source-recordings-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(id: string, files: Record<string, unknown>): Promise<void> {
    await mkdir(join(root, id), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(
        join(root, id, name),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
  }

  const response = {
    url: feedA.url,
    status: 200,
    contentType: 'application/xml',
    fetchedAt: '2026-10-17T08:00:00.000Z',
    bodyFile: 'body.xml',
  };
  const expected = { reviewed: false, entryCount: 0, items: [] };

  it('is empty when the folder does not exist', async () => {
    expect(await loadSourceRecordings(join(root, 'missing'), [feedA])).toEqual([]);
  });

  it('reads the response, the body and the expected items of each source', async () => {
    await write('feed-a', {
      'response.json': response,
      'body.xml': '<rss/>',
      'expected.json': expected,
    });

    const [loaded] = await loadSourceRecordings(root, [feedA]);

    expect(loaded?.source).toEqual(feedA);
    expect(loaded?.body).toBe('<rss/>');
    expect(loaded?.expected).toEqual({ ...expected, knownGaps: [] });
  });

  it('skips a source whose recording failed (an error and no body)', async () => {
    await write('feed-a', {
      'response.json': { ...response, bodyFile: undefined, error: 'timeout' },
    });

    expect(await loadSourceRecordings(root, [feedA])).toEqual([]);
  });

  it('throws naming the folder for a source it does not know', async () => {
    await write('mystery', { 'response.json': response });

    await expect(loadSourceRecordings(root, [feedA])).rejects.toThrow(/mystery/);
  });

  it('throws when a recorded body has no expected.json', async () => {
    await write('feed-a', { 'response.json': response, 'body.xml': '<rss/>' });

    await expect(loadSourceRecordings(root, [feedA])).rejects.toThrow(/expected\.json/);
  });

  it('throws when the body file named by response.json is missing', async () => {
    await write('feed-a', { 'response.json': response, 'expected.json': expected });

    await expect(loadSourceRecordings(root, [feedA])).rejects.toThrow(/body\.xml/);
  });

  it('refuses a body file outside the source folder', async () => {
    await write('feed-a', {
      'response.json': { ...response, bodyFile: '../secret.xml' },
      'expected.json': expected,
    });

    await expect(loadSourceRecordings(root, [feedA])).rejects.toThrow(/bodyFile/);
  });
});

describe('SOURCE_ALLOWED_HOSTS', () => {
  it('lists the hosts docs/sources.md allows', async () => {
    const { readFile } = await import('node:fs/promises');
    const doc = await readFile(join(import.meta.dirname, '..', '..', 'docs', 'sources.md'), 'utf8');
    const line = doc.split('\n\n').find((p) => p.startsWith('Only these hosts are contacted'))!;
    const hosts = [...line.matchAll(/`([a-z0-9.-]+)`/g)].map((m) => m[1]);

    expect([...SOURCE_ALLOWED_HOSTS].sort()).toEqual([...hosts].sort());
  });
});
