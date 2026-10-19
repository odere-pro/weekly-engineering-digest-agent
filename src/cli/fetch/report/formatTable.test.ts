import { describe, expect, it } from 'vitest';
import { makeFailedReport, makeReport } from '../__fixtures__/makeReport';
import { formatTable } from './formatTable';

const lines = (table: string): string[] => table.split('\n');

describe('formatTable', () => {
  it('is only the header when there are no reports', () => {
    expect(formatTable([])).toBe('Source  Status  HTTP  Items  Skipped  Time  Error');
  });

  it('prints one row per report in the given order', () => {
    const table = formatTable([
      makeReport({ source: { id: 'b-feed', kind: 'rss', url: 'https://b.example/f' } }),
      makeReport({ source: { id: 'a-feed', kind: 'rss', url: 'https://a.example/f' } }),
    ]);

    expect(lines(table).map((line) => line.split(/\s+/)[0])).toEqual([
      'Source',
      'b-feed',
      'a-feed',
    ]);
  });

  it('shows status, HTTP status, item count, skipped entries and time of a source that worked', () => {
    const row = lines(formatTable([makeReport()]))[1];

    expect(row?.split(/\s{2,}/)).toEqual(['example-feed', 'ok', '200', '2', '3', '1.5s']);
  });

  it('shows a dash for what a failed source never had: HTTP status and entry count', () => {
    const row = lines(formatTable([makeFailedReport('fetch failed')]))[1];

    expect(row?.split(/\s{2,}/)).toEqual([
      'example-feed',
      'failed',
      '-',
      '0',
      '-',
      '1.5s',
      'fetch failed',
    ]);
  });

  it('pads every column to its widest cell, so the columns line up', () => {
    const table = formatTable([
      makeReport(),
      makeFailedReport('boom', {
        source: { id: 'a-much-longer-source-id', kind: 'rss', url: 'https://x.example/f' },
      }),
    ]);

    const statusColumn = lines(table).map((line) => line.indexOf('Status'));
    const second = lines(table)[2] ?? '';
    expect(statusColumn[0]).toBe('a-much-longer-source-id'.length + 2);
    expect(second.indexOf('failed')).toBe(statusColumn[0]);
    expect(lines(table)[1]?.indexOf('ok')).toBe(statusColumn[0]);
  });

  it('leaves no trailing spaces on a line', () => {
    for (const line of lines(formatTable([makeReport(), makeFailedReport('x')]))) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('cuts a long error to 80 characters', () => {
    const row = lines(formatTable([makeFailedReport('word '.repeat(60))]))[1] ?? '';

    const error = row.split(/\s{2,}/).at(-1) ?? '';
    expect(error.length).toBeLessThanOrEqual(80);
    expect(error.endsWith('...')).toBe(true);
  });

  it('keeps an error of exactly 80 characters whole', () => {
    const error = 'e'.repeat(80);

    expect(formatTable([makeFailedReport(error)])).toContain(error);
  });

  it('shows how long a source took in minutes when it was slow', () => {
    const row = lines(formatTable([makeReport({ durationMs: 75_000 })]))[1] ?? '';

    expect(row).toContain('1m');
  });
});
