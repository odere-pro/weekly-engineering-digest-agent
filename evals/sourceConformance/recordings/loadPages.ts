import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DigestError, errorMessage } from '../../../src/shared/errors';
import type { SourceExpected } from '../../schema';

/** Not `.html`: prettier would try to format a recorded page, and fail on some. */
const PAGE_FILE = /^([0-9a-f]+)\.html\.txt$/;

/** `pages/<item id>.html.txt` of a source, keyed by the URL of the expected item with that id. */
export async function loadPages(
  dir: string,
  expected: SourceExpected,
): Promise<Record<string, string>> {
  const pagesDir = join(dir, 'pages');
  let names: string[];
  try {
    names = (await readdir(pagesDir)).sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw new DigestError(`Cannot read ${pagesDir}: ${errorMessage(error)}`, { cause: error });
  }
  const urlById = new Map(expected.items.map((item) => [item.id, item.url]));
  const pages: Record<string, string> = {};
  for (const name of names) {
    const id = PAGE_FILE.exec(name)?.[1];
    const url = id === undefined ? undefined : urlById.get(id);
    if (url === undefined) {
      throw new DigestError(`${join(pagesDir, name)} matches no expected item of the source`);
    }
    pages[url] = await readFile(join(pagesDir, name), 'utf8');
  }
  return pages;
}
