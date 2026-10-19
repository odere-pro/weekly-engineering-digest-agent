import { describe, expect, it } from 'vitest';
import { DigestError } from '../../../shared/errors';
import type { Item, Source, SourceKind } from '../../../domain/schemas';
import type { FetchWindow, SourceFetcher } from '../../../sources/SourceFetcher';
import { makeItem } from '../../../../test/builders';
import { FakeSourceFetcher } from '../../../../test/fakes';
import { errorText, fetchSource } from './fetchSource';
import { createRecorder } from './recorder';
import type { FetchRun } from './types';

const SOURCE: Source = { id: 'feed-a', kind: 'rss', url: 'https://example.com/a.xml' };
const SINCE = new Date('2026-10-06T00:00:00Z');
const UNTIL = new Date('2026-10-13T00:00:00Z');

/** A clock that moves `stepMs` each time it is read. */
function steppingClock(stepMs: number): FetchRun['clock'] {
  let reads = 0;
  return { now: () => new Date(UNTIL.getTime() + stepMs * reads++) };
}

function runWith(
  rss: SourceFetcher,
  overrides: Partial<FetchRun> = {},
  github: SourceFetcher = new FakeSourceFetcher('github', {}),
): FetchRun {
  return {
    fetchers: { rss, github },
    recorder: createRecorder(),
    window: { since: SINCE, until: UNTIL },
    maxItemsPerSource: 20,
    clock: steppingClock(250),
    timeoutMs: 1_000,
    redact: (text) => text,
    ...overrides,
  };
}

const never = (kind: SourceKind): SourceFetcher => ({
  kind,
  fetch: () => new Promise<Item[]>(() => undefined),
});

describe('fetchSource', () => {
  it('reports the items, how long it took and no error when the fetch works', async () => {
    const items = [makeItem({ sourceId: 'feed-a' })];
    const rss = new FakeSourceFetcher('rss', { 'feed-a': items });

    const report = await fetchSource(SOURCE, runWith(rss));

    expect(report).toEqual({
      source: SOURCE,
      ok: true,
      items,
      httpStatus: undefined,
      answeredBy: undefined,
      entries: undefined,
      durationMs: 250,
      error: undefined,
    });
  });

  it('takes the HTTP status, the answering URL and the entry count from the recorder', async () => {
    const run = runWith(new FakeSourceFetcher('rss', { 'feed-a': [] }));
    run.recorder.tap.answer({
      sourceId: 'feed-a',
      url: 'https://example.com/moved.xml',
      status: 301,
      contentType: undefined,
      body: '',
    });
    run.recorder.tap.answer({
      sourceId: 'feed-a',
      url: 'https://example.com/final.xml',
      status: 200,
      contentType: 'application/rss+xml',
      body: '<rss/>',
    });
    run.recorder.tap.entries({ sourceId: 'feed-a', parsed: 5, skipped: 2 });

    const report = await fetchSource(SOURCE, run);

    expect(report.httpStatus).toBe(200);
    expect(report.answeredBy).toBe('https://example.com/final.xml');
    expect(report.entries).toEqual({ sourceId: 'feed-a', parsed: 5, skipped: 2 });
  });

  it('does not take the answers of another source', async () => {
    const run = runWith(new FakeSourceFetcher('rss', { 'feed-a': [] }));
    run.recorder.tap.answer({
      sourceId: 'feed-b',
      url: 'https://example.com/b.xml',
      status: 500,
      contentType: undefined,
      body: '',
    });

    const report = await fetchSource(SOURCE, run);

    expect(report.httpStatus).toBeUndefined();
  });

  it('turns a failing fetch into a failed report with no items, and still reports the status', async () => {
    const rss = new FakeSourceFetcher('rss', {
      'feed-a': new DigestError('HTTP 500 fetching feed-a'),
    });
    const run = runWith(rss);
    run.recorder.tap.answer({
      sourceId: 'feed-a',
      url: SOURCE.url,
      status: 500,
      contentType: undefined,
      body: 'oops',
    });

    const report = await fetchSource(SOURCE, run);

    expect(report).toEqual(
      expect.objectContaining({
        ok: false,
        items: [],
        httpStatus: 500,
        error: 'HTTP 500 fetching feed-a',
        durationMs: 250,
      }),
    );
  });

  it('gives up on a fetch that does not answer within the time limit', async () => {
    const report = await fetchSource(SOURCE, runWith(never('rss'), { timeoutMs: 15 }));

    expect(report.ok).toBe(false);
    expect(report.error).toBe('Timed out after 15 ms');
  });

  it('uses the fetcher of the source kind', async () => {
    const rss = new FakeSourceFetcher('rss', {});
    const github = new FakeSourceFetcher('github', { 'acme-widgets': [makeItem()] });
    const repo: Source = { id: 'acme-widgets', kind: 'github', url: 'https://github.com/acme/w' };

    const report = await fetchSource(repo, runWith(rss, {}, github));

    expect(report.items).toHaveLength(1);
    expect(rss.calls).toEqual([]);
    expect(github.calls).toHaveLength(1);
  });

  it("asks for the run's window, capped at the config's limit", async () => {
    const rss = new FakeSourceFetcher('rss', {});

    await fetchSource(SOURCE, runWith(rss, { maxItemsPerSource: 12 }));

    const window: FetchWindow = { since: SINCE, until: UNTIL, maxItems: 12 };
    expect(rss.calls.map((call) => call.window)).toEqual([window]);
  });

  it("lets the source's own limit win over the config's", async () => {
    const rss = new FakeSourceFetcher('rss', {});

    await fetchSource({ ...SOURCE, maxItems: 3 }, runWith(rss, { maxItemsPerSource: 12 }));

    expect(rss.calls[0]?.window.maxItems).toBe(3);
  });

  it('removes secrets from the error before it is cut', async () => {
    const rss = new FakeSourceFetcher('rss', { 'feed-a': new Error('login failed for hunter2') });
    const redact = (text: string): string => text.replaceAll('hunter2', '[redacted]');

    const report = await fetchSource(SOURCE, runWith(rss, { redact }));

    expect(report.error).toBe('login failed for [redacted]');
  });
});

describe('errorText', () => {
  const same = (text: string): string => text;

  it('is the error message', () => {
    expect(errorText(new Error('HTTP 500 fetching feed-a'), same)).toBe('HTTP 500 fetching feed-a');
  });

  it('reads the text of something that is not an Error', () => {
    expect(errorText('plain failure', same)).toBe('plain failure');
  });

  it('puts the message on one line', () => {
    expect(errorText(new Error('first\n  second\t\tthird'), same)).toBe('first second third');
  });

  it('drops control and format characters: escapes, bidi overrides', () => {
    const line = errorText(new Error('bad\u001b[31m\u009b feed\u202Egnp\u200Bend'), same);

    expect(line).toBe('bad[31m feedgnpend');
  });

  it('cuts a long message to 300 characters', () => {
    const line = errorText(new Error('word '.repeat(200)), same);

    expect(line.length).toBeLessThanOrEqual(300);
    expect(line.endsWith('...')).toBe(true);
  });

  it('leaves a message of exactly 300 characters whole', () => {
    const message = 'x'.repeat(300);

    expect(errorText(new Error(message), same)).toBe(message);
  });

  it('removes secrets before the cut, so no piece of one is left at the end', () => {
    const secret = 'ghp_TESTTOKEN0123456789';
    const redact = (text: string): string => text.replaceAll(secret, '[redacted]');
    const message = `${'x'.repeat(290)}${secret}`;

    const line = errorText(new Error(message), redact);

    expect(line).not.toContain('ghp_');
    expect(line).toContain('[redacted]');
  });
});
