import { makeItem } from '../../../../test/builders';
import type { Source } from '../../../domain/schemas';
import type { SourceReport } from '../sourceRun/types';

const SOURCE: Source = { id: 'example-feed', kind: 'rss', url: 'https://example.com/feed.xml' };

/** A source that worked: two items, HTTP 200, 3 of 5 entries read, 1.5 s. */
export function makeReport(overrides: Partial<SourceReport> = {}): SourceReport {
  const source = overrides.source ?? SOURCE;
  return {
    source,
    ok: true,
    items: [makeItem({ sourceId: source.id }), makeItem({ sourceId: source.id })],
    httpStatus: 200,
    answeredBy: source.url,
    entries: { sourceId: source.id, parsed: 5, skipped: 3 },
    durationMs: 1_500,
    error: undefined,
    ...overrides,
  };
}

/** A source that failed before any answer: no status, no items, no entries. */
export function makeFailedReport(
  error: string,
  overrides: Partial<SourceReport> = {},
): SourceReport {
  return makeReport({
    ok: false,
    items: [],
    httpStatus: undefined,
    answeredBy: undefined,
    entries: undefined,
    error,
    ...overrides,
  });
}
