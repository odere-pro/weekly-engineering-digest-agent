import { describe, expect, it } from 'vitest';
import type { SavedSource } from '../../../sources/adapters/archive/sourceArchive';
import { makeFailedReport, makeReport } from '../__fixtures__/makeReport';
import { summaryOf } from './summaryOf';

const HEADER = {
  startedAt: new Date('2026-10-13T00:00:00Z'),
  windowDays: 7,
  run: {
    window: { since: new Date('2026-10-06T00:00:00Z'), until: new Date('2026-10-13T00:00:00Z') },
  },
};

const SAVED: SavedSource = {
  raw: ['example-feed/raw/response-1.xml'],
  formatted: 'example-feed/formatted/items.json',
};

describe('summaryOf', () => {
  it('describes the start, the window and the totals', () => {
    const summary = summaryOf(
      HEADER,
      [makeReport(), makeFailedReport('oops')],
      [SAVED, { raw: [] }],
    );

    expect(summary).toEqual(
      expect.objectContaining({
        startedAt: '2026-10-13T00:00:00.000Z',
        window: {
          since: '2026-10-06T00:00:00.000Z',
          until: '2026-10-13T00:00:00.000Z',
          days: 7,
        },
        totals: { sources: 2, ok: 1, failed: 1, items: 2 },
      }),
    );
  });

  it('describes a source that worked, with the files saved for it', () => {
    const summary = summaryOf(HEADER, [makeReport({ durationMs: 40 })], [SAVED]) as {
      sources: unknown[];
    };

    expect(summary.sources).toEqual([
      {
        id: 'example-feed',
        kind: 'rss',
        status: 'ok',
        httpStatus: 200,
        answeredBy: 'https://example.com/feed.xml',
        entries: 5,
        skipped: 3,
        items: 2,
        durationMs: 40,
        error: null,
        raw: ['example-feed/raw/response-1.xml'],
        formatted: 'example-feed/formatted/items.json',
      },
    ]);
  });

  it('writes null, not undefined, for what a failed source never had, so the key stays in the JSON', () => {
    const summary = summaryOf(HEADER, [makeFailedReport('HTTP 500')], [{ raw: ['x/raw/r.html'] }]);

    const json = JSON.parse(JSON.stringify(summary)) as { sources: Record<string, unknown>[] };
    expect(json.sources[0]).toEqual({
      id: 'example-feed',
      kind: 'rss',
      status: 'failed',
      httpStatus: null,
      answeredBy: null,
      entries: null,
      skipped: null,
      items: 0,
      durationMs: 1_500,
      error: 'HTTP 500',
      raw: ['x/raw/r.html'],
      formatted: null,
    });
  });

  it('lists a source whose files were not saved with no raw files and no formatted file', () => {
    const summary = summaryOf(HEADER, [makeReport()], []) as {
      sources: { raw: string[]; formatted: string | null }[];
    };

    expect(summary.sources[0]).toEqual(expect.objectContaining({ raw: [], formatted: null }));
  });

  it('matches each source with the files saved at its position', () => {
    const other = { id: 'other', kind: 'rss', url: 'https://o.example/f' } as const;

    const summary = summaryOf(
      HEADER,
      [makeReport(), makeReport({ source: other })],
      [{ raw: ['one'] }, { raw: ['two'] }],
    ) as { sources: { id: string; raw: string[] }[] };

    expect(summary.sources.map((source) => [source.id, source.raw])).toEqual([
      ['example-feed', ['one']],
      ['other', ['two']],
    ]);
  });
});
