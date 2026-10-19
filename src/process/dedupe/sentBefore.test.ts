import { describe, expect, it } from 'vitest';
import { sentBefore } from './sentBefore';
import { entryOf, scored } from '../__fixtures__/processKit';

const isSent = (url: string, sentUrls: readonly string[]): boolean =>
  sentBefore(new Set(sentUrls))(entryOf(scored('item', {}, { url })));

describe('sentBefore', () => {
  it('flags an item whose URL was sent in a recent week, not a fresh one', () => {
    const sent = ['https://example.com/posts/sent'];

    expect(isSent('https://example.com/posts/sent', sent)).toBe(true);
    expect(isSent('https://example.com/posts/fresh', sent)).toBe(false);
  });

  it('matches through URL normalization (utm params, fragment, trailing slash, host case)', () => {
    const url = 'https://Example.com/posts/launch/?utm_source=rss&utm_medium=feed#intro';

    expect(isSent(url, ['https://example.com/posts/launch'])).toBe(true);
  });

  it('normalizes the sent URLs too, so a tracked URL in the run record still matches', () => {
    const sent = ['https://example.com/posts/launch?utm_campaign=weekly'];

    expect(isSent('https://example.com/posts/launch', sent)).toBe(true);
  });

  it('does not treat a different path or query as sent', () => {
    const sent = ['https://example.com/posts/launch'];

    expect(isSent('https://example.com/posts/launch?page=2', sent)).toBe(false);
    expect(isSent('https://example.com/posts/other', sent)).toBe(false);
  });

  it('flags nothing when no URL was sent', () => {
    expect(isSent('https://example.com/posts/launch', [])).toBe(false);
  });

  it('does not modify the sent set it is given', () => {
    const sent = new Set(['https://example.com/a?utm_source=rss']);

    sentBefore(sent)(entryOf(scored('x')));

    expect([...sent]).toEqual(['https://example.com/a?utm_source=rss']);
  });
});
