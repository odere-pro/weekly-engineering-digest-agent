import { describe, expect, it, vi } from 'vitest';
import type { Source } from '../../../domain/schemas';
import { noopLogger } from '../../../shared/telemetry';
import { readEntries, reportUnusable } from './readEntries';
import type { RawEntry } from './types';

const source: Source = { id: 'blog', kind: 'rss', url: 'https://example.com/feed.xml' };
const raw = (overrides: Partial<RawEntry> = {}): RawEntry => ({
  url: 'https://example.com/a',
  title: 'A title',
  text: 'Some text',
  publishedAt: '2026-10-10T08:00:00Z',
  ...overrides,
});
const poisoned = (message: string): RawEntry => ({
  ...raw(),
  get title(): string {
    throw new RangeError(message);
  },
});

describe('readEntries', () => {
  it('pairs each readable entry with the item it became, in order', () => {
    const entries = [raw({ url: 'https://example.com/1' }), raw({ url: 'https://example.com/2' })];

    const { pairs, failures } = readEntries(entries, source, 600);

    expect(failures).toEqual([]);
    expect(pairs.map((pair) => pair.item.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
    ]);
    expect(pairs.map((pair) => pair.entry)).toEqual(entries);
  });

  it('passes the summary length to the normalization', () => {
    const { pairs } = readEntries([raw({ text: 'word '.repeat(100) })], source, 40);
    expect(pairs[0]?.item.summary.length).toBeLessThanOrEqual(40);
  });

  it('leaves out an entry without a usable link or date, and does not call it a failure', () => {
    const { pairs, failures } = readEntries(
      [raw({ url: '' }), raw({ publishedAt: 'sometime' }), raw({ url: 'javascript:alert(1)' })],
      source,
      600,
    );
    expect(pairs).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('leaves out an entry whose link is over 2048 characters, and does not call it a failure', () => {
    const padded = raw({ url: `https://example.com/${'a'.repeat(2_100)}` });

    const { pairs, failures } = readEntries([padded, raw()], source, 600);

    expect(pairs.map((pair) => pair.item.url)).toEqual(['https://example.com/a']);
    expect(failures).toEqual([]);
  });

  it('cuts a padded title in the item it keeps', () => {
    const { pairs } = readEntries([raw({ title: 'T '.repeat(5_000) })], source, 600);
    expect(pairs[0]?.item.title.length).toBeLessThanOrEqual(300);
  });

  it('leaves out an item that fails the item schema', () => {
    // Year 10000 prints as +010000-..., which is not an ISO date time the schema accepts.
    const beyondYear9999 = raw({ publishedAt: new Date(Date.UTC(10_000, 0, 1)) });
    const { pairs, failures } = readEntries([beyondYear9999, raw()], source, 600);
    expect(pairs).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it('records the message of an entry that throws and keeps the others', () => {
    const { pairs, failures } = readEntries(
      [poisoned('bad entry'), raw(), poisoned('worse entry')],
      source,
      600,
    );
    expect(pairs).toHaveLength(1);
    expect(failures).toEqual(['bad entry', 'worse entry']);
  });

  it('reads an empty list', () => {
    expect(readEntries([], source, 600)).toEqual({ pairs: [], failures: [] });
  });
});

describe('reportUnusable', () => {
  const pair = readEntries([raw()], source, 600).pairs;

  it('warns once, with the first error, when entries threw', () => {
    const warn = vi.fn();
    reportUnusable({ ...noopLogger, warn }, source, 3, {
      pairs: pair,
      failures: ['first', 'second'],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Skipped feed entries that could not be read', {
      sourceId: 'blog',
      failed: 2,
      of: 3,
      firstError: 'first',
    });
  });

  it('cuts a long error text before it reaches the log', () => {
    const warn = vi.fn();
    reportUnusable({ ...noopLogger, warn }, source, 1, {
      pairs: [],
      failures: ['x'.repeat(1_000)],
    });
    const fields = warn.mock.calls[0]?.[1] as { firstError: string };
    expect(fields.firstError.length).toBeLessThanOrEqual(300);
  });

  it('warns when the feed had entries and none became an item', () => {
    const warn = vi.fn();
    reportUnusable({ ...noopLogger, warn }, source, 4, { pairs: [], failures: [] });
    expect(warn).toHaveBeenCalledWith('No feed entry had a usable link and date', {
      sourceId: 'blog',
      entries: 4,
    });
  });

  it('warns for a feed whose every link was over 2048 characters', () => {
    const warn = vi.fn();
    const padded = raw({ url: `https://example.com/${'a'.repeat(2_100)}` });
    const reading = readEntries([padded], source, 600);

    reportUnusable({ ...noopLogger, warn }, source, 1, reading);

    expect(warn).toHaveBeenCalledWith('No feed entry had a usable link and date', {
      sourceId: 'blog',
      entries: 1,
    });
  });

  it('says nothing for an empty feed', () => {
    const warn = vi.fn();
    reportUnusable({ ...noopLogger, warn }, source, 0, { pairs: [], failures: [] });
    expect(warn).not.toHaveBeenCalled();
  });

  it('says nothing when at least one entry became an item', () => {
    const warn = vi.fn();
    reportUnusable({ ...noopLogger, warn }, source, 2, { pairs: pair, failures: [] });
    expect(warn).not.toHaveBeenCalled();
  });
});
