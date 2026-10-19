import { describe, expect, it } from 'vitest';
import { ItemSchema, type Source } from '../../../domain/schemas';
import { itemIdFor } from '../../../shared/url';
import { normalizeEntry } from './normalizeEntry';
import type { RawEntry } from './types';

const source: Source = { id: 'blog', kind: 'rss', url: 'https://example.com/feed.xml' };
const raw = (overrides: Partial<RawEntry> = {}): RawEntry => ({
  url: 'https://example.com/a',
  title: ' A title ',
  text: '<p>Some <b>text</b> &amp; more</p>',
  publishedAt: '2026-10-10T08:00:00Z',
  ...overrides,
});
const options = { maxSummaryChars: 600 };

describe('normalizeEntry', () => {
  it('builds the item: id from the url, plain summary, trimmed title, ISO date', () => {
    expect(normalizeEntry(raw(), source, options)).toEqual({
      id: itemIdFor('https://example.com/a'),
      sourceId: 'blog',
      kind: 'rss',
      url: 'https://example.com/a',
      title: 'A title',
      summary: 'Some text & more',
      publishedAt: '2026-10-10T08:00:00.000Z',
    });
  });

  it('takes the kind from the source, not from the entry', () => {
    const github: Source = { id: 'repo', kind: 'github', url: 'https://github.com/o/r' };
    const item = normalizeEntry(raw(), github, options);
    expect(item).toMatchObject({ sourceId: 'repo', kind: 'github' });
  });

  it('builds an item that passes the item schema', () => {
    expect(ItemSchema.safeParse(normalizeEntry(raw(), source, options)).success).toBe(true);
  });

  it('truncates the summary to maxSummaryChars', () => {
    const item = normalizeEntry(raw({ text: 'word '.repeat(100) }), source, {
      maxSummaryChars: 50,
    });
    expect(item?.summary.length).toBeLessThanOrEqual(50);
    expect(item?.summary.endsWith('...')).toBe(true);
  });

  it('gives an empty summary for an entry without text', () => {
    expect(normalizeEntry(raw({ text: '' }), source, options)?.summary).toBe('');
  });

  it.each([
    ['an empty url', { url: '' }],
    ['a blank url', { url: '   ' }],
    ['a relative url', { url: '/posts/a' }],
    ['a javascript url', { url: 'javascript:alert(1)' }],
    ['an ftp url', { url: 'ftp://example.com/a' }],
    ['a data url', { url: 'data:text/html,<p>x</p>' }],
    ['an unparseable date', { publishedAt: 'sometime' }],
    ['an empty date', { publishedAt: '' }],
    ['an invalid Date', { publishedAt: new Date('nope') }],
  ])('drops an entry with %s', (_name, overrides) => {
    expect(normalizeEntry(raw(overrides), source, options)).toBeUndefined();
  });

  it('trims the url and accepts a plain http link', () => {
    const item = normalizeEntry(raw({ url: '  http://example.com/a  ' }), source, options);
    expect(item?.url).toBe('http://example.com/a');
  });

  it('reads a date without a zone as UTC and accepts a Date', () => {
    expect(
      normalizeEntry(raw({ publishedAt: '2026-10-10 08:00' }), source, options)?.publishedAt,
    ).toBe('2026-10-10T08:00:00.000Z');
    expect(
      normalizeEntry(raw({ publishedAt: new Date('2026-10-10T09:00:00Z') }), source, options)
        ?.publishedAt,
    ).toBe('2026-10-10T09:00:00.000Z');
  });

  it('appends the entry id as ?entry= only when the link is shared', () => {
    const entry = raw({ url: 'https://example.com/notes?x=1', entryId: 'id 1' });

    expect(normalizeEntry(entry, source, options)?.url).toBe('https://example.com/notes?x=1');
    const distinct = normalizeEntry(entry, source, { ...options, distinctLink: true });
    expect(distinct?.url).toBe('https://example.com/notes?x=1&entry=id%201');
    expect(distinct?.id).toBe(itemIdFor(distinct?.url ?? ''));
  });

  it('starts the query when the shared link has none', () => {
    const entry = raw({ url: 'https://example.com/notes', entryId: 'a' });
    const item = normalizeEntry(entry, source, { ...options, distinctLink: true });
    expect(item?.url).toBe('https://example.com/notes?entry=a');
  });

  it('keeps the link when a shared-link entry has no entry id', () => {
    const item = normalizeEntry(raw(), source, { ...options, distinctLink: true });
    expect(item?.url).toBe('https://example.com/a');
  });

  it('throws what a value it cannot handle throws, for the caller to skip the entry', () => {
    const poisoned = {
      ...raw(),
      get title(): string {
        throw new RangeError('bad entry');
      },
    };
    expect(() => normalizeEntry(poisoned, source, options)).toThrow('bad entry');
  });
});
