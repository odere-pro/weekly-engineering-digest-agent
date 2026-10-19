import { describe, expect, it, vi } from 'vitest';
import {
  MAX_LINK_CHARS,
  MAX_TRAILING_CHARS,
  collectedUrlFor,
  indexCollectedUrls,
  withSchemes,
} from './withSchemes';

const DOCKER_URL = 'https://www.docker.com/blog/spec/';
const GUIDE_URL = 'https://docs.example.org/guide?id=7';
const PLAIN_HTTP_URL = 'http://plain.example.net/a';
const known = indexCollectedUrls([DOCKER_URL, GUIDE_URL, PLAIN_HTTP_URL]);

describe('indexCollectedUrls', () => {
  it('keys each url by its normalised form and keeps the url as written', () => {
    const index = indexCollectedUrls(['https://Example.com/a/?utm_source=x#top']);

    expect([...index.values()]).toEqual(['https://Example.com/a/?utm_source=x#top']);
    expect(index.has('https://example.com/a')).toBe(true);
  });

  it('is empty for no urls', () => {
    expect(indexCollectedUrls([]).size).toBe(0);
  });
});

describe('collectedUrlFor', () => {
  it.each([
    ['a www link', 'www.docker.com/blog/spec/', DOCKER_URL],
    ['a protocol-relative link', '//www.docker.com/blog/spec/', DOCKER_URL],
    ['a link without the trailing slash', 'www.docker.com/blog/spec', DOCKER_URL],
    ['a link in another host case', 'WWW.Docker.com/blog/spec/', DOCKER_URL],
    ['a link with tracking parameters', 'www.docker.com/blog/spec/?utm_source=x#top', DOCKER_URL],
    ['a protocol-relative link with a query', '//docs.example.org/guide?id=7', GUIDE_URL],
  ])('names the collected url for %s', (_name, token, expected) => {
    expect(collectedUrlFor(token, known)).toBe(expected);
  });

  it.each([
    ['a closing bracket', ')'],
    ['a comma and a bracket', '),'],
    ['a bracket and a full stop', ').'],
    ['emphasis marks', '**'],
    ['an exclamation mark', '!'],
  ])('puts back %s that follows the link', (_name, tail) => {
    expect(collectedUrlFor(`www.docker.com/blog/spec/${tail}`, known)).toBe(`${DOCKER_URL}${tail}`);
  });

  it.each([
    ['a host that was never collected', 'www.evil.example/payload'],
    ['a longer path than the collected url', 'www.docker.com/blog/spec/evil'],
    ['a collected host with another path', 'www.docker.com/blog/other'],
    ['a collected host whose name only starts the same', 'www.docker.com.evil.example/blog/spec/'],
    ['a collected host with credentials in front', 'www.docker.com@evil.example/x'],
    ['a url collected as http', '//plain.example.net/a'],
    ['an empty link', ''],
  ])('returns the token as it is for %s, so the link check rejects it', (_name, token) => {
    expect(collectedUrlFor(token, known)).toBe(token);
  });

  it('never returns a url that is not collected, whatever the token ends with', () => {
    const tokens = [
      'www.evil.example/a',
      '//evil.example/b)))',
      'www.docker.com/blog/spec/))))))))))',
      'www.docker.com/blog/spec/)))',
    ];
    const collected = new Set(known.values());

    const urls = tokens.flatMap((token) => {
      const url = collectedUrlFor(token, known).match(/https?:\/\/[^\s)]+/)?.[0];
      return url === undefined ? [] : [url];
    });

    // The repairable token is the only one that gains a scheme, and it gains a collected url.
    expect(urls).toEqual([DOCKER_URL]);
    for (const url of urls) expect(collected.has(url)).toBe(true);
  });

  it('loses a full stop that follows a url ending in a slash: the parser reads it as a path segment (known quirk)', () => {
    expect(collectedUrlFor('www.docker.com/blog/spec/.', known)).toBe(DOCKER_URL);
    expect(collectedUrlFor('docs.example.org/guide?id=7.', known)).toBe(`${GUIDE_URL}.`);
  });

  it(`takes up to ${MAX_TRAILING_CHARS} closing characters off the end, and no more`, () => {
    const within = `www.docker.com/blog/spec/${')'.repeat(MAX_TRAILING_CHARS)}`;
    const beyond = `www.docker.com/blog/spec/${')'.repeat(MAX_TRAILING_CHARS + 1)}`;

    expect(collectedUrlFor(within, known)).toBe(`${DOCKER_URL}${')'.repeat(MAX_TRAILING_CHARS)}`);
    expect(collectedUrlFor(beyond, known)).toBe(beyond);
  });

  it(`skips a token longer than ${MAX_LINK_CHARS} characters without a lookup`, () => {
    const lookups = { get: vi.fn(() => undefined) };
    const token = `www.${'a'.repeat(MAX_LINK_CHARS)}`;

    const result = collectedUrlFor(token, lookups as unknown as ReadonlyMap<string, string>);

    expect(result).toBe(token);
    expect(lookups.get).not.toHaveBeenCalled();
  });
});

describe('withSchemes', () => {
  it('repairs each scheme-less link that names a collected url and reports each repair', () => {
    const onRepair = vi.fn();

    const text = withSchemes(
      'See www.docker.com/blog/spec/ and (//docs.example.org/guide?id=7).',
      known,
      onRepair,
    );

    expect(text).toBe(`See ${DOCKER_URL} and (${GUIDE_URL}).`);
    expect(onRepair).toHaveBeenCalledTimes(2);
  });

  it('does not report a link it left as it was', () => {
    const onRepair = vi.fn();
    const original = 'See www.evil.example/x and //evil.example/y.';

    const text = withSchemes(original, known, onRepair);

    expect(text).toBe(original);
    expect(onRepair).not.toHaveBeenCalled();
  });

  it('does not touch a link that has its scheme, or one inside the query of a url', () => {
    const onRepair = vi.fn();
    const original = `Read ${DOCKER_URL} and https://example.com/r?u=//docs.example.org/guide?id=7 now.`;

    expect(withSchemes(original, known, onRepair)).toBe(original);
    expect(onRepair).not.toHaveBeenCalled();
  });

  it('returns the text as it is when nothing was collected', () => {
    const onRepair = vi.fn();
    const text = 'See www.docker.com/blog/spec/ now.';

    expect(withSchemes(text, indexCollectedUrls([]), onRepair)).toBe(text);
    expect(onRepair).not.toHaveBeenCalled();
  });

  it('returns a text with nothing link-like as it is', () => {
    expect(withSchemes('No links, only a/b paths.', known, () => undefined)).toBe(
      'No links, only a/b paths.',
    );
  });
});
