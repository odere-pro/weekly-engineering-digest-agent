import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SOURCES } from '../../../src/sources/defaultSources';
import { feedA, goodItem } from '../__fixtures__/conformanceKit';
import { loadSourceRecordings } from './loadSourceRecordings';

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

describe('loadSourceRecordings', () => {
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
    expect(loaded?.response).toEqual(response);
    expect(loaded?.body).toBe('<rss/>');
    expect(loaded?.expected).toEqual({ ...expected, knownGaps: [] });
  });

  it('reads pages/<item id>.html.txt as the page of the expected item with that id', async () => {
    const item = goodItem('feed-a', 1);
    await write('feed-a', {
      'response.json': response,
      'body.xml': '<rss/>',
      'expected.json': { ...expected, items: [item] },
    });
    await mkdir(join(root, 'feed-a', 'pages'), { recursive: true });
    await writeFile(join(root, 'feed-a', 'pages', `${item.id}.html.txt`), '<html>one</html>');

    const [loaded] = await loadSourceRecordings(root, [feedA]);

    expect(loaded?.pages).toEqual({ [item.url]: '<html>one</html>' });
  });

  it('has no pages when the folder has none', async () => {
    await write('feed-a', {
      'response.json': response,
      'body.xml': '<rss/>',
      'expected.json': expected,
    });

    const [loaded] = await loadSourceRecordings(root, [feedA]);

    expect(loaded?.pages).toEqual({});
  });

  it('throws on a page that matches no expected item', async () => {
    await write('feed-a', {
      'response.json': response,
      'body.xml': '<rss/>',
      'expected.json': expected,
    });
    await mkdir(join(root, 'feed-a', 'pages'), { recursive: true });
    await writeFile(join(root, 'feed-a', 'pages', 'deadbeef.html.txt'), '<html/>');

    await expect(loadSourceRecordings(root, [feedA])).rejects.toThrow(/deadbeef\.html/);
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

  it('reads the recordings in source id order, one per folder', async () => {
    const repo = { id: 'repo-b', kind: 'github' as const, url: 'https://github.com/ollama/ollama' };
    for (const source of [repo, feedA]) {
      await write(source.id, {
        'response.json': { ...response, url: source.url },
        'body.xml': `<rss>${source.id}</rss>`,
        'expected.json': expected,
      });
    }

    const loaded = await loadSourceRecordings(root, [repo, feedA]);

    expect(loaded.map((recording) => recording.source.id)).toEqual(['feed-a', 'repo-b']);
  });

  it('knows the default sources when no list is given', async () => {
    const [first] = DEFAULT_SOURCES;
    await write(first!.id, {
      'response.json': { ...response, url: first!.url },
      'body.xml': '<rss/>',
      'expected.json': expected,
    });

    const [loaded] = await loadSourceRecordings(root);

    expect(loaded?.source).toEqual(first);
  });
});
