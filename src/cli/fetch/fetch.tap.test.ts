import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// The tap that captures raw bodies (W8-06) serves `digest fetch` and a run's source archive: the
// container gives the run's fetchers the archive's tap, so a week keeps what each source answered
// (dist/<monday>/<source>/raw). Nothing else may pass one, or build a fetcher that takes one.

const ROOT = join(import.meta.dirname, '..', '..', '..');
const TAP_OWNERS = [
  'src/app/container.ts',
  'src/cli/fetch/fetch.ts',
  'src/sources/adapters/archive/archivingFetcher.ts',
  'src/sources/adapters/githubReleases.ts',
  'src/sources/adapters/http.ts',
  'src/sources/adapters/pipeline.ts',
  'src/sources/adapters/rss.ts',
];
/** Whole words, so `{ fetch, tap }`, `tap,` and `options.tap = …` are all seen. */
const TAP_WORDS = /\b(?:tap|SourceTap|onAnswer|SourceAnswer|SourceEntries)\b/;
/** Every module that builds a fetcher straight from an adapter. */
const FETCHER_BUILDERS = [
  'evals/recordSources.ts',
  'src/cli/fetch/fetch.ts',
  'src/sources/adapters/githubReleases.ts',
  'src/sources/adapters/pipeline.ts',
  'src/sources/adapters/rss.ts',
];
/** Tests sit next to the code; only product code counts here. */
const TEST_HELPERS = new Set(['evals/evalKit.ts', 'src/store/adapters/lockContender.ts']);

function isProductCode(path: string): boolean {
  return !path.endsWith('.test.ts') && !path.includes('__fixtures__') && !TEST_HELPERS.has(path);
}

async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for (const folder of ['src', 'evals']) {
    const entries = await readdir(join(ROOT, folder), { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const path = relative(ROOT, join(entry.parentPath, entry.name));
      if (!isProductCode(path)) continue;
      files.push({ path, text: await readFile(join(ROOT, path), 'utf8') });
    }
  }
  return files;
}

describe('the source tap', () => {
  it('is named only by the pipeline, the HTTP reader, the fetchers, the archive and `digest fetch`', async () => {
    const mentions = (await sourceFiles())
      .filter(({ text }) => TAP_WORDS.test(text))
      .map(({ path }) => path);

    expect(mentions.sort()).toEqual(TAP_OWNERS);
  });

  it('can only be passed by a module that builds a fetcher from an adapter', async () => {
    const builders = (await sourceFiles())
      .filter(({ text }) => /\bcreateFetcher\(/.test(text))
      .map(({ path }) => path);

    expect(builders.sort()).toEqual(FETCHER_BUILDERS);
  });
});
