import { describe, expect, it } from 'vitest';
import { itemIdFor, normalizeUrl, sameUrl } from './url';

describe('normalizeUrl', () => {
  it('removes tracking params, fragment, default port and trailing slash', () => {
    expect(normalizeUrl('https://Example.com:443/Blog/Post/?utm_source=x&b=2&a=1&ref=hn#top')).toBe(
      'https://example.com/Blog/Post?a=1&b=2',
    );
  });

  it('keeps the root slash and http default port removal', () => {
    expect(normalizeUrl('http://example.com:80/')).toBe('http://example.com/');
  });

  it('returns non-http input unchanged', () => {
    expect(normalizeUrl(' mailto:a@b.c ')).toBe('mailto:a@b.c');
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});

describe('item ids', () => {
  it('are stable across equivalent URLs', () => {
    expect(itemIdFor('https://example.com/a?utm_campaign=z')).toBe(
      itemIdFor('https://EXAMPLE.com/a/'),
    );
    expect(itemIdFor('https://example.com/a')).toMatch(/^[0-9a-f]{16}$/);
    expect(sameUrl('https://example.com/a#x', 'https://example.com/a')).toBe(true);
    expect(sameUrl('https://example.com/a', 'https://example.com/b')).toBe(false);
  });
});
