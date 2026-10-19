import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Source } from '../../../domain/schemas';
import { makeItem } from '../../../../test/builders';
import { allFiles, readJson, useTempDir } from '../__fixtures__/fetchHarness';
import { makeFailedReport, makeReport } from '../__fixtures__/makeReport';
import { createRecorder } from '../sourceRun/recorder';
import type { SourceReport } from '../sourceRun/types';
import { saveRun, SUMMARY_FILE, type SavePlan } from './saveRun';

const dir = useTempDir();

const FEED: Source = { id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' };
const OTHER: Source = { id: 'other-feed', kind: 'rss', url: 'https://other.example/feed.xml' };
const SECRET = 'ghp_TESTTOKEN0123456789';
const noRedact = {
  generated: (text: string): string => text,
  collected: (text: string): string => text,
};

/** A plan for the test folder, and a way to record what a source answered. */
function setup(): {
  plan: SavePlan;
  answerFor: (source: Source, body: string, contentType?: string) => void;
} {
  const recorder = createRecorder();
  return {
    plan: {
      root: dir(),
      day: '2026-10-13',
      startedAt: new Date('2026-10-13T00:00:00Z'),
      windowDays: 7,
      run: {
        window: {
          since: new Date('2026-10-06T00:00:00Z'),
          until: new Date('2026-10-13T00:00:00Z'),
        },
        recorder,
      },
    },
    answerFor: (source, body, contentType = 'application/rss+xml') => {
      recorder.tap.answer({ sourceId: source.id, url: source.url, status: 200, contentType, body });
    },
  };
}

const worked = (source: Source): SourceReport =>
  makeReport({ source, items: [makeItem({ sourceId: source.id, title: 'Release 1' })] });

describe('saveRun', () => {
  it("saves each source's answers and items, then the summary", async () => {
    const { plan, answerFor } = setup();
    answerFor(FEED, '<rss/>');
    answerFor(OTHER, '<feed/>', 'application/atom+xml');

    await saveRun(plan, [worked(FEED), worked(OTHER)], noRedact);

    expect(await allFiles(join(dir(), '2026-10-13'))).toEqual([
      'example-feed/formatted/items.json',
      'example-feed/raw/response-1.xml',
      'example-feed/raw/responses.json',
      'fetch-summary.json',
      'other-feed/formatted/items.json',
      'other-feed/raw/response-1.xml',
      'other-feed/raw/responses.json',
    ]);
    expect(
      await readFile(join(dir(), '2026-10-13', 'example-feed/raw/response-1.xml'), 'utf8'),
    ).toBe('<rss/>');
  });

  it('keeps the items of a source that worked and none for one that failed', async () => {
    const { plan, answerFor } = setup();
    answerFor(FEED, '<rss/>');
    answerFor(OTHER, 'oops', 'text/html');

    await saveRun(plan, [worked(FEED), makeFailedReport('HTTP 500', { source: OTHER })], noRedact);

    const folder = join(dir(), '2026-10-13');
    expect(await allFiles(join(folder, 'other-feed'))).toEqual([
      'raw/response-1.html',
      'raw/responses.json',
    ]);
    const items = (await readJson(join(folder, 'example-feed/formatted/items.json'))) as {
      title: string;
    }[];
    expect(items.map((item) => item.title)).toEqual(['Release 1']);
  });

  it('writes a summary that names the files saved for each source', async () => {
    const { plan, answerFor } = setup();
    answerFor(FEED, '<rss/>');

    await saveRun(plan, [worked(FEED)], noRedact);

    const summary = (await readJson(join(dir(), '2026-10-13', SUMMARY_FILE))) as {
      sources: { id: string; raw: string[]; formatted: string | null }[];
      totals: unknown;
    };
    expect(summary.sources).toEqual([
      expect.objectContaining({
        id: 'example-feed',
        raw: ['example-feed/raw/response-1.xml'],
        formatted: 'example-feed/formatted/items.json',
      }),
    ]);
    expect(summary.totals).toEqual({ sources: 1, ok: 1, failed: 0, items: 1 });
  });

  it('ends the summary file with a newline, as every JSON file of the project does', async () => {
    const { plan } = setup();

    await saveRun(plan, [worked(FEED)], noRedact);

    expect(await readFile(join(dir(), '2026-10-13', SUMMARY_FILE), 'utf8')).toMatch(/\}\n$/);
  });

  it('cleans the summary with `generated` and the collected data only with `collected`', async () => {
    const { plan, answerFor } = setup();
    answerFor(FEED, `<rss>token ${SECRET} and hunter2</rss>`);
    const report = makeFailedReport('login failed for hunter2', { source: FEED });

    await saveRun(plan, [report], {
      generated: (text) =>
        text.replaceAll(SECRET, '[redacted]').replaceAll('hunter2', '[redacted]'),
      collected: (text) => text.replaceAll(SECRET, '[redacted]'),
    });

    const folder = join(dir(), '2026-10-13');
    expect(await readFile(join(folder, SUMMARY_FILE), 'utf8')).not.toContain('hunter2');
    expect(await readFile(join(folder, 'example-feed/raw/response-1.xml'), 'utf8')).toBe(
      '<rss>token [redacted] and hunter2</rss>',
    );
  });

  it('replaces the files of an earlier save of the day, and leaves other folders alone', async () => {
    const folder = join(dir(), '2026-10-13');
    await mkdir(join(folder, 'example-feed', 'raw'), { recursive: true });
    await writeFile(join(folder, 'example-feed', 'raw', 'response-2.xml'), 'old');
    await writeFile(join(folder, SUMMARY_FILE), 'earlier');
    await mkdir(join(folder, 'digest'), { recursive: true });
    await writeFile(join(folder, 'digest', 'run.json'), '{}');
    const { plan, answerFor } = setup();
    answerFor(FEED, '<rss/>');

    await saveRun(plan, [worked(FEED)], noRedact);

    expect(await readdir(join(folder, 'example-feed', 'raw'))).toEqual([
      'response-1.xml',
      'responses.json',
    ]);
    expect(await readFile(join(folder, SUMMARY_FILE), 'utf8')).not.toBe('earlier');
    expect(await readFile(join(folder, 'digest', 'run.json'), 'utf8')).toBe('{}');
  });

  it('saves a source that has no answers: an index of none and its items', async () => {
    const { plan } = setup();

    await saveRun(plan, [worked(FEED)], noRedact);

    const folder = join(dir(), '2026-10-13', 'example-feed');
    expect(await allFiles(folder)).toEqual(['formatted/items.json', 'raw/responses.json']);
    expect(await readJson(join(folder, 'raw/responses.json'))).toEqual([]);
  });

  it('writes the summary last: when a later source cannot be saved there is none', async () => {
    const { plan, answerFor } = setup();
    answerFor(FEED, '<rss/>');
    answerFor(OTHER, '<rss/>');
    const folder = join(dir(), '2026-10-13');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'other-feed'), 'a file where the source folder should go');

    const save = saveRun(plan, [worked(FEED), worked(OTHER)], noRedact);

    await expect(save).rejects.toThrow(/ENOTDIR|EEXIST/);
    expect((await readdir(folder)).sort()).toEqual(['example-feed', 'other-feed']);
  });
});
