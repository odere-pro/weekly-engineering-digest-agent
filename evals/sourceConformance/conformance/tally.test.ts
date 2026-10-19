import { describe, expect, it } from 'vitest';
import { itemIdFor } from '../../../src/shared/url';
import { feedA, goodItem, recording } from '../__fixtures__/conformanceKit';
import { MIN_SUMMARY_CHARS, hasWrongId, tally } from './tally';

describe('tally', () => {
  it('counts a clean fetch as fully parsed with no defects', () => {
    const items = [goodItem('feed-a', 1), goodItem('feed-a', 2)];

    expect(tally(recording(feedA, items), items)).toEqual({
      sourceId: 'feed-a',
      parsed: 2,
      expected: 2,
      schemaInvalid: 0,
      emptyTitle: 0,
      emptySummary: 0,
      badDate: 0,
      idMismatch: 0,
      hostOutsideAllowlist: 0,
    });
  });

  it('counts parsed against the items the recording must yield', () => {
    const result = tally(recording(feedA, [goodItem('feed-a', 1), goodItem('feed-a', 2)]), [
      goodItem('feed-a', 1),
    ]);

    expect(result).toMatchObject({ parsed: 1, expected: 2 });
  });

  it('counts a title of spaces as empty', () => {
    const result = tally(recording(feedA, []), [goodItem('feed-a', 1, { title: ' \n ' })]);

    expect(result.emptyTitle).toBe(1);
  });

  it('counts a summary shorter than MIN_SUMMARY_CHARS as empty, one of that length as filled', () => {
    const result = tally(recording(feedA, []), [
      goodItem('feed-a', 1, { summary: 'x'.repeat(MIN_SUMMARY_CHARS - 1) }),
      goodItem('feed-a', 2, { summary: 'x'.repeat(MIN_SUMMARY_CHARS) }),
      goodItem('feed-a', 3, { summary: `   ${'x'.repeat(MIN_SUMMARY_CHARS - 1)}   ` }),
    ]);

    expect(result.emptySummary).toBe(2);
  });

  it('counts a date that does not parse as a bad date', () => {
    const result = tally(recording(feedA, []), [
      goodItem('feed-a', 1, { publishedAt: 'last Tuesday' }),
    ]);

    expect(result.badDate).toBe(1);
  });

  it('counts an id that is not the hash of the url', () => {
    const result = tally(recording(feedA, []), [goodItem('feed-a', 1, { id: 'not-the-hash' })]);

    expect(result.idMismatch).toBe(1);
  });

  it('counts a host outside the allowlist', () => {
    const url = 'https://evil.example.net/x';
    const result = tally(recording(feedA, []), [
      goodItem('feed-a', 1, { url, id: itemIdFor(url) }),
    ]);

    expect(result.hostOutsideAllowlist).toBe(1);
  });

  it('counts an item the item schema rejects', () => {
    const result = tally(recording(feedA, []), [
      goodItem('feed-a', 1, { url: 'not a url' }),
      goodItem('feed-a', 2),
    ]);

    expect(result.schemaInvalid).toBe(1);
  });

  it('is all zero for a fetch that returned nothing', () => {
    expect(tally(recording(feedA, [goodItem('feed-a', 1)]), [])).toEqual({
      sourceId: 'feed-a',
      parsed: 0,
      expected: 1,
      schemaInvalid: 0,
      emptyTitle: 0,
      emptySummary: 0,
      badDate: 0,
      idMismatch: 0,
      hostOutsideAllowlist: 0,
    });
  });
});

describe('hasWrongId', () => {
  it('is false when the id is the hash of the url', () => {
    expect(hasWrongId(goodItem('feed-a', 1))).toBe(false);
  });

  it('is true for another id, and for a url that does not match the id', () => {
    expect(hasWrongId(goodItem('feed-a', 1, { id: 'other' }))).toBe(true);
    expect(hasWrongId(goodItem('feed-a', 1, { url: 'not a url' }))).toBe(true);
  });

  it('is true, not a throw, when a fetcher left the url out', () => {
    const noUrl = goodItem('feed-a', 1, { url: undefined as unknown as string });

    expect(hasWrongId(noUrl)).toBe(true);
  });
});
