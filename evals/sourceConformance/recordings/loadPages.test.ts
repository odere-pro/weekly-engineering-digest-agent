import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { goodItem } from '../__fixtures__/conformanceKit';
import { loadPages } from './loadPages';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'recording-pages-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const first = goodItem('feed-a', 1);
const second = goodItem('feed-a', 2);
const expected = { reviewed: true, entryCount: 2, items: [first, second], knownGaps: [] };

async function writePage(name: string, html: string): Promise<void> {
  await mkdir(join(dir, 'pages'), { recursive: true });
  await writeFile(join(dir, 'pages', name), html);
}

describe('loadPages', () => {
  it('has no pages when the source folder has no pages folder', async () => {
    expect(await loadPages(dir, expected)).toEqual({});
  });

  it('keys each page by the URL of the expected item with the id in its file name', async () => {
    await writePage(`${second.id}.html.txt`, '<html>two</html>');
    await writePage(`${first.id}.html.txt`, '<html>one</html>');

    expect(await loadPages(dir, expected)).toEqual({
      [first.url]: '<html>one</html>',
      [second.url]: '<html>two</html>',
    });
  });

  it('throws, naming the file, for a page that matches no expected item', async () => {
    await writePage('deadbeef.html.txt', '<html/>');

    await expect(loadPages(dir, expected)).rejects.toThrow(
      /deadbeef\.html\.txt matches no expected/,
    );
  });

  it('throws for a file that does not follow the pages/<item id>.html.txt naming', async () => {
    await writePage(`${first.id}.html`, '<html/>');

    await expect(loadPages(dir, expected)).rejects.toThrow(/matches no expected item/);
  });

  it('throws, naming the path, when pages is not a folder', async () => {
    await writeFile(join(dir, 'pages'), 'a file');

    await expect(loadPages(dir, expected)).rejects.toThrow(`Cannot read ${join(dir, 'pages')}`);
  });
});
