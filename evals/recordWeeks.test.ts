import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, resolveConfig } from 'prettier';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECORDED_ITEMS_PER_SOURCE,
  THIN_WEEK_MIN_ITEMS,
  bucketByWeek,
  recordWeeks,
  renderCandidates,
  resolveSources,
  type RecordWeeksDeps,
} from './recordWeeks';
import { createGithubReleasesFetcher } from '../src/sources/adapters/githubReleases';
import { createRssFetcher } from '../src/sources/adapters/rss';
import { DEFAULT_SOURCES } from '../src/sources/defaultSources';
import type { LoadOptions } from '../src/config/load';
import { ItemSchema, type Item, type Source, type SourceKind } from '../src/domain/schemas';
import type { SourceFetcher } from '../src/sources/SourceFetcher';
import { DigestError } from '../src/shared/errors';
import { fixedClock } from '../src/shared/clock';
import type { Logger } from '../src/shared/telemetry';
import { FakeSourceFetcher } from '../test/fakes/FakeSourceFetcher';
import { makeItem } from '../test/builders';

// The real factories, with a spy on each: a test can see the options the recorder gave them and
// swap the fetcher for one that makes no request.
vi.mock('../src/sources/adapters/rss', async (importOriginal) => {
  const actual = await importOriginal<{ createRssFetcher: typeof createRssFetcher }>();
  return { ...actual, createRssFetcher: vi.fn(actual.createRssFetcher) };
});
vi.mock('../src/sources/adapters/githubReleases', async (importOriginal) => {
  const actual = await importOriginal<{
    createGithubReleasesFetcher: typeof createGithubReleasesFetcher;
  }>();
  return { ...actual, createGithubReleasesFetcher: vi.fn(actual.createGithubReleasesFetcher) };
});

const DAY_MS = 86_400_000;
/** A Wednesday in 2021-W03; the six complete weeks before it straddle the 2020/2021 boundary. */
const NOW = '2021-01-20T12:00:00Z';
const RECORDED_WEEKS = ['2020-W50', '2020-W51', '2020-W52', '2020-W53', '2021-W01', '2021-W02'];

const fixtures = join(import.meta.dirname, '..', 'test', 'fixtures', 'config');
const feedA: Source = { id: 'feed-a', kind: 'rss', url: 'https://a.example.com/feed.xml' };
const repoB: Source = {
  id: 'repo-b',
  kind: 'github',
  url: 'https://github.com/example/repo-b',
  maxItems: 5,
};

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'record-weeks-'));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function itemAt(publishedAt: string, overrides: Partial<Item> = {}): Item {
  return makeItem({ sourceId: feedA.id, publishedAt, ...overrides });
}

/** `count` distinct items spread over the day starting at `isoDay` (YYYY-MM-DD). */
function itemsOnDay(isoDay: string, count: number, overrides: Partial<Item> = {}): Item[] {
  return Array.from({ length: count }, (_, i) =>
    itemAt(`${isoDay}T${String(i % 24).padStart(2, '0')}:30:00Z`, overrides),
  );
}

interface Run {
  returned: string[];
  lines: string[];
  rssFetcher: FakeSourceFetcher;
  githubFetcher: FakeSourceFetcher;
}

async function run(
  bySource: Readonly<Record<string, Item[] | Error>>,
  deps: Partial<RecordWeeksDeps> = {},
  weeks = 6,
): Promise<Run> {
  const rssFetcher = new FakeSourceFetcher('rss', bySource);
  const githubFetcher = new FakeSourceFetcher('github', bySource);
  const lines: string[] = [];
  const returned = await recordWeeks(
    { weeks, outDir },
    {
      sources: [feedA, repoB],
      fetchers: { rss: rssFetcher, github: githubFetcher },
      clock: fixedClock(NOW),
      log: (line) => lines.push(line),
      retries: 0,
      ...deps,
    },
  );
  return { returned, lines, rssFetcher, githubFetcher };
}

const readItems = async (week: string): Promise<Item[]> =>
  ItemSchema.array().parse(JSON.parse(await readFile(join(outDir, week, 'items.json'), 'utf8')));

describe('bucketByWeek', () => {
  it('assigns items to ISO weeks across a year boundary', () => {
    const sunday = itemAt('2020-12-27T23:59:59Z');
    const mondayW53 = itemAt('2020-12-28T00:00:00Z');
    const sundayW53 = itemAt('2021-01-03T23:59:59Z');
    const mondayW01 = itemAt('2021-01-04T00:00:00Z');

    const buckets = bucketByWeek(
      [sunday, mondayW53, sundayW53, mondayW01],
      ['2020-W52', '2020-W53', '2021-W01'],
    );

    expect(buckets.get('2020-W52')).toEqual([sunday]);
    expect(buckets.get('2020-W53')).toEqual([mondayW53, sundayW53]);
    expect(buckets.get('2021-W01')).toEqual([mondayW01]);
  });

  it('puts the last days of a calendar year into week 01 of the next ISO year', () => {
    const item = itemAt('2024-12-30T08:00:00Z');

    const buckets = bucketByWeek([item], ['2024-W52', '2025-W01']);

    expect(buckets.get('2025-W01')).toEqual([item]);
    expect(buckets.get('2024-W52')).toEqual([]);
  });

  it('keeps every requested week, drops other weeks and keeps the input order', () => {
    const later = itemAt('2021-01-06T10:00:00Z');
    const earlier = itemAt('2021-01-05T10:00:00Z');
    const outside = itemAt('2021-02-01T10:00:00Z');

    const buckets = bucketByWeek([later, outside, earlier], ['2021-W01', '2021-W02']);

    expect([...buckets.keys()]).toEqual(['2021-W01', '2021-W02']);
    expect(buckets.get('2021-W01')).toEqual([later, earlier]);
    expect(buckets.get('2021-W02')).toEqual([]);
  });
});

describe('renderCandidates', () => {
  it('lists each item as a numbered entry with id, source, title, URL and summary', () => {
    const first = itemAt('2021-01-05T10:00:00Z', {
      id: 'aaaa1111bbbb2222',
      title: 'Ollama 0.5 adds tool calling',
      url: 'https://example.com/ollama-0-5',
      summary: 'Streaming tool calls land.',
    });
    const second = itemAt('2021-01-04T09:00:00Z', {
      id: 'cccc3333dddd4444',
      sourceId: 'repo-b',
      kind: 'github',
      title: 'v1.2.0',
      url: 'https://github.com/example/repo-b/releases/tag/v1.2.0',
      summary: 'Bug fixes.',
    });

    const markdown = renderCandidates('2021-W01', [first, second]);

    expect(markdown.startsWith('# Candidates: 2021-W01\n')).toBe(true);
    expect(markdown).toContain('2 items');
    expect(markdown).toContain('1. **Ollama 0.5 adds tool calling**');
    expect(markdown).toContain('2. **v1.2.0**');
    expect(markdown).toContain('- id: `aaaa1111bbbb2222`');
    expect(markdown).toContain('- source: feed-a, published 2021-01-05');
    expect(markdown).toContain('- source: repo-b, published 2021-01-04');
    expect(markdown).toContain('- url: https://example.com/ollama-0-5');
    expect(markdown).toContain('- summary: Streaming tool calls land.');
    expect(markdown.indexOf('1. **Ollama')).toBeLessThan(markdown.indexOf('2. **v1.2.0'));
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('cuts the summary to 200 characters and keeps each entry on single lines', () => {
    const item = itemAt('2021-01-05T10:00:00Z', {
      title: 'A title\nwith a   line break',
      summary: `${'word '.repeat(100)}\nsecond line`,
    });

    const markdown = renderCandidates('2021-W01', [item]);

    const summaryLine = markdown.split('\n').find((line) => line.startsWith('   - summary: '));
    expect(summaryLine).toBeDefined();
    expect((summaryLine ?? '').slice('   - summary: '.length).length).toBeLessThanOrEqual(200);
    expect(summaryLine).toMatch(/\.\.\.$/);
    expect(markdown).toContain('1. **A title with a line break**');
  });

  it('marks items without a title or summary', () => {
    const markdown = renderCandidates('2021-W01', [
      itemAt('2021-01-05T10:00:00Z', { title: '', summary: '' }),
    ]);

    expect(markdown).toContain('1. **(untitled)**');
    expect(markdown).toContain('- summary: (none)');
  });

  it('says so when the week has no items', () => {
    const markdown = renderCandidates('2021-W01', []);

    expect(markdown).toContain('No items were recorded for this week.');
  });
});

describe('resolveSources', () => {
  const noEnv = (overrides: LoadOptions = {}): LoadOptions => ({
    envPath: join(fixtures, 'missing.env'),
    processEnv: {},
    platform: { os: 'darwin', arch: 'arm64' },
    ...overrides,
  });

  it('falls back to the default allowlist when there is no config file', async () => {
    const resolved = await resolveSources(noEnv({ configPath: join(fixtures, 'missing.json') }));

    expect(resolved.sources).toEqual(DEFAULT_SOURCES);
    expect(resolved.githubToken).toBeUndefined();
  });

  it('uses the configured sources and the GitHub token from the environment', async () => {
    const resolved = await resolveSources(
      noEnv({
        configPath: join(fixtures, 'valid.config.json'),
        processEnv: { GITHUB_TOKEN: 'ghp_example' },
      }),
    );

    expect(resolved.sources.map((source) => source.id)).toEqual(['example-feed']);
    expect(resolved.githubToken).toBe('ghp_example');
  });

  it('fails when the config path cannot be checked instead of using the defaults', async () => {
    await expect(
      resolveSources(noEnv({ configPath: join(fixtures, 'valid.config.json', 'nested.json') })),
    ).rejects.toThrow(/ENOTDIR/);
  });

  it('fails on an invalid config instead of silently using the defaults', async () => {
    await expect(
      resolveSources(noEnv({ configPath: join(fixtures, 'bad-schema.config.json') })),
    ).rejects.toBeInstanceOf(DigestError);
  });
});

describe('recordWeeks', () => {
  it('records the six complete ISO weeks before the current one', async () => {
    const { returned } = await run({
      'feed-a': [
        itemAt('2020-12-31T10:00:00Z'),
        itemAt('2021-01-04T10:00:00Z'),
        itemAt('2021-01-12T10:00:00Z'),
      ],
    });

    expect(returned).toEqual(RECORDED_WEEKS);
    expect((await readdir(outDir)).toSorted()).toEqual(RECORDED_WEEKS);
    expect((await readItems('2020-W53')).map((item) => item.publishedAt)).toEqual([
      '2020-12-31T10:00:00Z',
    ]);
    expect((await readItems('2021-W01')).map((item) => item.publishedAt)).toEqual([
      '2021-01-04T10:00:00Z',
    ]);
    expect((await readItems('2021-W02')).map((item) => item.publishedAt)).toEqual([
      '2021-01-12T10:00:00Z',
    ]);
  });

  it('leaves out the running week and anything older than the six weeks', async () => {
    await run({
      'feed-a': [
        itemAt('2021-01-19T10:00:00Z'), // 2021-W03, still running
        itemAt('2021-01-12T10:00:00Z'), // 2021-W02
        itemAt('2020-12-03T10:00:00Z'), // 2020-W49, inside the 7-week window but not recorded
      ],
    });

    const recorded = await Promise.all(RECORDED_WEEKS.map(readItems));

    expect(recorded.flat().map((item) => item.publishedAt)).toEqual(['2021-01-12T10:00:00Z']);
    expect(await readdir(outDir)).not.toContain('2021-W03');
    expect(await readdir(outDir)).not.toContain('2020-W49');
  });

  it('records the number of weeks asked for', async () => {
    const { returned } = await run({ 'feed-a': [itemAt('2021-01-12T10:00:00Z')] }, {}, 2);

    expect(returned).toEqual(['2021-W01', '2021-W02']);
  });

  it.each([0, -1, 1.5])('rejects %s weeks before touching the network', async (weeks) => {
    const rssFetcher = new FakeSourceFetcher('rss', {});

    await expect(
      recordWeeks({ weeks, outDir }, { sources: [feedA], fetchers: { rss: rssFetcher } }),
    ).rejects.toBeInstanceOf(DigestError);
    expect(rssFetcher.calls).toEqual([]);
  });

  it('collects a 7-week window with the recorder cap for every source', async () => {
    const { rssFetcher, githubFetcher } = await run({});

    const [rssCall] = rssFetcher.calls;
    const [githubCall] = githubFetcher.calls;
    expect(rssCall?.window.maxItems).toBe(RECORDED_ITEMS_PER_SOURCE);
    expect(githubCall?.window.maxItems).toBe(RECORDED_ITEMS_PER_SOURCE);
    expect(rssCall?.source.id).toBe('feed-a');
    expect(githubCall?.source.id).toBe('repo-b');
    expect(rssCall?.window.until.toISOString()).toBe('2021-01-20T12:00:00.000Z');
    expect(rssCall?.window.since.getTime()).toBe(Date.parse(NOW) - 49 * DAY_MS);
  });

  it('writes items newest first, with schema-valid items', async () => {
    await run({
      'feed-a': [itemAt('2021-01-11T10:00:00Z'), itemAt('2021-01-13T10:00:00Z')],
      'repo-b': [itemAt('2021-01-12T10:00:00Z', { sourceId: 'repo-b', kind: 'github' })],
    });

    expect((await readItems('2021-W02')).map((item) => item.publishedAt)).toEqual([
      '2021-01-13T10:00:00Z',
      '2021-01-12T10:00:00Z',
      '2021-01-11T10:00:00Z',
    ]);
  });

  it('writes a labels.json template next to the items', async () => {
    await run({ 'feed-a': [itemAt('2021-01-12T10:00:00Z')] });

    for (const week of RECORDED_WEEKS) {
      const labels: unknown = JSON.parse(await readFile(join(outDir, week, 'labels.json'), 'utf8'));
      expect(labels).toEqual({ mustInclude: [], mustExclude: [], notes: '' });
    }
  });

  it('never overwrites an existing labels.json', async () => {
    const labels = '{"mustInclude":["abc"],"mustExclude":[],"notes":"hand written"}\n';
    await mkdir(join(outDir, '2021-W02'), { recursive: true });
    await writeFile(join(outDir, '2021-W02', 'labels.json'), labels);

    await run({ 'feed-a': [itemAt('2021-01-12T10:00:00Z')] });
    await run({ 'feed-a': [itemAt('2021-01-12T10:00:00Z')] });

    expect(await readFile(join(outDir, '2021-W02', 'labels.json'), 'utf8')).toBe(labels);
  });

  it('keeps recorded items the feeds no longer serve and adds the new ones', async () => {
    const recorded = itemAt('2021-01-12T10:00:00Z', {
      id: 'recorded-item',
      sourceId: 'retired-feed',
      title: 'Recorded title',
    });
    await mkdir(join(outDir, '2021-W02'), { recursive: true });
    await writeFile(join(outDir, '2021-W02', 'items.json'), JSON.stringify([recorded]));

    const { lines } = await run({
      'feed-a': [itemAt('2021-01-13T10:00:00Z', { id: 'new-item', title: 'New title' })],
    });

    expect((await readItems('2021-W02')).map((item) => item.id)).toEqual([
      'new-item',
      'recorded-item',
    ]);
    const candidates = await readFile(join(outDir, '2021-W02', 'candidates.md'), 'utf8');
    expect(candidates).toContain('Recorded title');
    expect(candidates).toContain('New title');
    expect(lines.join('\n')).toMatch(/2021-W02.*1 already recorded, 1 added/);
    expect(lines.join('\n')).toMatch(/retired-feed\s+1\b/);
  });

  it('does not touch items.json when a re-run finds nothing new', async () => {
    const recorded = itemAt('2021-01-12T10:00:00Z', { id: 'recorded-item', title: 'Old title' });
    const original = JSON.stringify([recorded]);
    await mkdir(join(outDir, '2021-W02'), { recursive: true });
    await writeFile(join(outDir, '2021-W02', 'items.json'), original);

    const { lines } = await run({
      'feed-a': [{ ...recorded, title: 'Edited upstream' }],
    });

    expect(await readFile(join(outDir, '2021-W02', 'items.json'), 'utf8')).toBe(original);
    expect(lines.join('\n')).toMatch(/2021-W02.*1 already recorded, 0 added/);
  });

  it('fills in the items of a source that failed on an earlier run', async () => {
    const fromA = itemAt('2021-01-12T10:00:00Z', { id: 'from-a' });
    const fromB = itemAt('2021-01-13T10:00:00Z', { id: 'from-b', sourceId: 'repo-b' });

    const first = await run({ 'feed-a': new Error('connect ECONNREFUSED'), 'repo-b': [fromB] });
    expect((await readItems('2021-W02')).map((item) => item.id)).toEqual(['from-b']);
    expect(first.lines.join('\n')).toMatch(/WARNING.*feed-a/);
    expect(first.lines.join('\n')).toContain('pnpm eval:record again');

    const second = await run({ 'feed-a': [fromA], 'repo-b': [fromB] });

    expect((await readItems('2021-W02')).map((item) => item.id)).toEqual(['from-b', 'from-a']);
    expect(second.lines.join('\n')).not.toContain('WARNING: 1 failed');
  });

  it('refuses an existing items.json that is not a list of items', async () => {
    await mkdir(join(outDir, '2021-W02'), { recursive: true });
    await writeFile(join(outDir, '2021-W02', 'items.json'), '{"not":"a list"}');

    await expect(run({ 'feed-a': [] })).rejects.toThrow(/2021-W02[\\/]items\.json/);
  });

  it('writes candidates.md for every week', async () => {
    await run({
      'feed-a': [itemAt('2021-01-12T10:00:00Z', { id: 'one', title: 'Only item' })],
    });

    const filled = await readFile(join(outDir, '2021-W02', 'candidates.md'), 'utf8');
    const empty = await readFile(join(outDir, '2021-W01', 'candidates.md'), 'utf8');
    expect(filled).toContain('1. **Only item**');
    expect(filled).toContain('- id: `one`');
    expect(empty).toContain('No items were recorded for this week.');
  });

  it('prints the count per week and per source', async () => {
    const { lines } = await run({
      'feed-a': [...itemsOnDay('2021-01-12', 3), ...itemsOnDay('2021-01-05', 2)],
      'repo-b': [itemAt('2021-01-13T10:00:00Z', { sourceId: 'repo-b', kind: 'github' })],
    });
    const output = lines.join('\n');

    expect(output).toMatch(/2021-W02\s+4 items/);
    expect(output).toMatch(/2021-W01\s+2 items/);
    expect(output).toMatch(/2020-W53\s+0 items/);
    expect(output).toMatch(/feed-a\s+5\b/);
    expect(output).toMatch(/repo-b\s+1\b/);
  });

  it('warns about weeks with fewer than 10 items and only those', async () => {
    const { lines } = await run({
      'feed-a': [
        ...itemsOnDay('2021-01-12', THIN_WEEK_MIN_ITEMS),
        ...itemsOnDay('2021-01-05', THIN_WEEK_MIN_ITEMS - 1),
      ],
    });

    const warnings = lines.filter((line) => line.includes('WARNING'));
    expect(THIN_WEEK_MIN_ITEMS).toBe(10);
    expect(warnings.some((line) => line.includes('2021-W02'))).toBe(false);
    expect(warnings.some((line) => line.includes('2021-W01') && line.includes('9 items'))).toBe(
      true,
    );
    expect(warnings.some((line) => line.includes('2020-W50'))).toBe(true);
  });

  it('lists sources that failed instead of stopping', async () => {
    const { lines } = await run({
      'feed-a': new Error('connect ECONNREFUSED'),
      'repo-b': [itemAt('2021-01-13T10:00:00Z', { sourceId: 'repo-b', kind: 'github' })],
    });

    expect(lines.join('\n')).toMatch(/WARNING: 1 failed sources: feed-a \(.*ECONNREFUSED/);
    expect((await readItems('2021-W02')).map((item) => item.sourceId)).toEqual(['repo-b']);
  });

  it('records the default allowlist when there is no config file', async () => {
    const { lines, rssFetcher, githubFetcher } = await run(
      {},
      {
        sources: undefined,
        config: { configPath: join(fixtures, 'missing.json'), processEnv: {} },
      },
    );

    const asked = [...rssFetcher.calls, ...githubFetcher.calls].map((call) => call.source.id);
    expect(asked.toSorted()).toEqual(DEFAULT_SOURCES.map((source) => source.id).toSorted());
    expect(lines.join('\n')).toContain(`Sources: ${DEFAULT_SOURCES.length} (default allowlist)`);
  });

  it('prints the report to the console by default', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await run({}, { log: undefined });

    expect(log.mock.calls.flat().join('\n')).toContain('Recorded 6 weeks (2020-W50 to 2021-W02)');
  });

  it('formats the files with the prettier config found next to them', async () => {
    await writeFile(join(outDir, '.prettierrc.json'), '{ "tabWidth": 4 }');

    await run({ 'feed-a': [itemAt('2021-01-12T10:00:00Z')] });

    const items = await readFile(join(outDir, '2021-W02', 'items.json'), 'utf8');
    expect(items).toMatch(/^\[\n {4}\{\n {8}"id"/);
  });

  it('writes files that pass the repo prettier check', async () => {
    await run({
      'feed-a': [
        itemAt('2021-01-12T10:00:00Z', {
          title: '*Bold* _claims_ [link] <b>html</b> | pipe # hash',
          summary: 'Uses `code`, 1. numbering and * stars',
        }),
      ],
    });

    for (const file of ['items.json', 'labels.json', 'candidates.md']) {
      const path = join(outDir, '2021-W02', file);
      const options = await resolveConfig(path);
      expect(await check(await readFile(path, 'utf8'), { ...options, filepath: path })).toBe(true);
    }
  });
});

describe('recordWeeks fetcher warnings', () => {
  const SKIPPED = 'Skipped feed entries that could not be read';
  const TOKEN = 'ghp_recorder-token-5d21';
  const ANY_FUNCTION: unknown = expect.any(Function);
  const ANY_LOGGER: unknown = expect.objectContaining({ warn: ANY_FUNCTION, child: ANY_FUNCTION });
  const withToken = (): Partial<RecordWeeksDeps> => ({
    fetchers: undefined,
    sources: undefined,
    config: {
      configPath: join(fixtures, 'valid.config.json'),
      envPath: join(fixtures, 'missing.env'),
      processEnv: { GITHUB_TOKEN: TOKEN },
      platform: { os: 'darwin', arch: 'arm64' },
    },
  });

  /**
   * Swaps both default fetchers for ones that make no request and call `act` with the logger
   * they were built with, once per source they are asked for.
   */
  function defaultFetchersThat(act: (logger: Logger, source: Source) => void): void {
    const fakeFetcher =
      (kind: SourceKind) =>
      (options: { logger?: Logger } | undefined): SourceFetcher => ({
        kind,
        fetch: (source) => {
          if (options?.logger) act(options.logger, source);
          return Promise.resolve([]);
        },
      });
    vi.mocked(createRssFetcher).mockImplementationOnce(fakeFetcher('rss'));
    vi.mocked(createGithubReleasesFetcher).mockImplementationOnce(fakeFetcher('github'));
  }

  const useDefaults = { fetchers: undefined };

  it('prints what the default fetchers skip as WARNING lines, before the report', async () => {
    defaultFetchersThat((logger, source) => {
      logger.warn(SKIPPED, { sourceId: source.id, failed: 1, of: 2 });
    });

    const { lines } = await run({}, useDefaults);

    const feedWarning = `WARNING: ${SKIPPED} (sourceId=feed-a failed=1 of=2)`;
    const repoWarning = `WARNING: ${SKIPPED} (sourceId=repo-b failed=1 of=2)`;
    expect(lines).toContain(feedWarning);
    expect(lines).toContain(repoWarning);
    const report = lines.findIndex((line) => line.startsWith('Recorded '));
    expect(lines.indexOf(feedWarning)).toBeLessThan(report);
    expect(lines.indexOf(repoWarning)).toBeLessThan(report);
    expect(lines.filter((line) => line.includes(SKIPPED))).toHaveLength(2);
  });

  it('keeps info and debug lines out of the report', async () => {
    defaultFetchersThat((logger, source) => {
      logger.info('Entry page could not be read', { sourceId: source.id });
      logger.debug('Retrying source', { sourceId: source.id });
    });

    const { lines } = await run({}, useDefaults);

    expect(lines.join('\n')).not.toContain('Entry page could not be read');
    expect(lines.join('\n')).not.toContain('Retrying source');
  });

  it('labels an error ERROR and adds the fields of a child logger, nested ones too', async () => {
    defaultFetchersThat((logger, source) => {
      if (source.kind === 'rss') {
        logger.child({ step: 'collect' }).child({ attempt: 2 }).error('Could not read', {
          sourceId: source.id,
        });
      }
    });

    const { lines } = await run({}, useDefaults);

    expect(lines).toContain('ERROR: Could not read (step=collect attempt=2 sourceId=feed-a)');
  });

  it('leaves a message without fields as it is, and shows other field values as JSON', async () => {
    defaultFetchersThat((logger, source) => {
      if (source.kind !== 'rss') return;
      logger.warn('Feed is odd');
      logger.warn('Counted', { entries: 3, tags: ['a', 'b'], nothing: null, flag: false });
    });

    const { lines } = await run({}, useDefaults);

    expect(lines).toContain('WARNING: Feed is odd');
    expect(lines).toContain('WARNING: Counted (entries=3 tags=["a","b"] nothing=null flag=false)');
  });

  it('prints each warning as one line, whatever a feed put in the error text', async () => {
    defaultFetchersThat((logger, source) => {
      if (source.kind === 'rss') logger.warn(SKIPPED, { firstError: 'bad\n  entry\r\nhere' });
    });

    const { lines } = await run({}, useDefaults);

    expect(lines).toContain(`WARNING: ${SKIPPED} (firstError=bad entry here)`);
  });

  it('takes the GitHub token out of a warning, in the message and in the fields', async () => {
    defaultFetchersThat((logger, source) => {
      logger.warn(`Cannot read ${TOKEN}`, {
        sourceId: source.id,
        firstError: `HTTP 401 for ${TOKEN}`,
      });
    });

    const { lines } = await run({}, withToken());

    const warnings = lines.filter((line) => line.startsWith('WARNING: '));
    expect(warnings).toEqual([
      'WARNING: Cannot read [redacted] (sourceId=example-feed firstError=HTTP 401 for [redacted])',
    ]);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('gives the GitHub fetcher the token from the environment and the report logger', async () => {
    defaultFetchersThat(() => undefined);

    await run({}, withToken());

    expect(createGithubReleasesFetcher).toHaveBeenCalledWith({
      token: TOKEN,
      logger: ANY_LOGGER,
    });
    expect(createRssFetcher).toHaveBeenCalledWith({ logger: ANY_LOGGER });
  });

  it('uses the fetchers it is given as they are', async () => {
    const { rssFetcher } = await run({});

    expect(rssFetcher.calls).toHaveLength(1);
    expect(createRssFetcher).not.toHaveBeenCalled();
    expect(createGithubReleasesFetcher).not.toHaveBeenCalled();
  });
});
