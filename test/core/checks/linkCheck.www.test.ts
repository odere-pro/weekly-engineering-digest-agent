// The `www.` inside a full https:// url is part of that url, not a scheme-less link (W5-11).
// Before, every collected url with a www host failed the check: it reported "Malformed or
// scheme-less link: www.docker.com/..." for the valid source link the renderer writes, and
// 2026-W39 had no digest because of it. Everything else stays strict.
import { describe, expect, it } from 'vitest';
import { linkCheck } from '../../../src/core/checks/linkCheck.js';
import { renderDigest } from '../../../src/core/render.js';
import type { Digest, Item } from '../../../src/core/schemas.js';
import { makeDigest, makeItem } from '../../builders.js';

const DOCKER_URL = 'https://www.docker.com/blog/docker-sandbox-kit-spec-cncf/';

const wwwItems = [
  makeItem({ url: DOCKER_URL }),
  makeItem({ url: 'https://www.example.org/news/launch' }),
  makeItem({ url: 'https://example.com/posts/plain' }),
];

const render = (digest: Digest): string => renderDigest(digest, { disabledGuards: [] });

/** The rendered digest of `items`, with `extra` on a line after it. */
function checkWith(extra: string, items: readonly Item[] = wwwItems) {
  const digest = makeDigest(items);
  return linkCheck(digest, `${render(digest)}\n${extra}`, items);
}

describe('linkCheck: a collected https://www. url is valid', () => {
  it('passes the digest the renderer writes for items with a www host', () => {
    const digest = makeDigest(wwwItems);

    expect(render(digest)).toContain(`](${DOCKER_URL})`);
    expect(linkCheck(digest, render(digest), wwwItems)).toEqual({ ok: true, problems: [] });
  });

  it('passes the url in a summary, a bare line, an autolink and a Markdown link', () => {
    const digest = makeDigest(wwwItems, { intro: `Read ${DOCKER_URL} first.` });
    const extra = [DOCKER_URL, `<${DOCKER_URL}>`, `[spec](${DOCKER_URL})`, `(${DOCKER_URL}).`].join(
      '\n',
    );

    expect(linkCheck(digest, `${render(digest)}\n${extra}`, wwwItems).ok).toBe(true);
  });

  it('passes a www url that differs only in case, a trailing slash or tracking parameters', () => {
    const extra = [
      'HTTPS://WWW.DOCKER.COM/blog/docker-sandbox-kit-spec-cncf',
      `${DOCKER_URL}?utm_source=feed#top`,
    ].join('\n');

    expect(checkWith(extra)).toEqual({ ok: true, problems: [] });
  });
});

describe('linkCheck: everything else with www stays rejected', () => {
  it.each([
    ['an unknown https www url', 'see https://www.evil.example/x', 'Unknown URL'],
    ['an unknown http www url', 'see http://www.evil.example', 'Unknown URL'],
    ['an unknown upper-case www url', 'see HTTPS://WWW.EVIL.EXAMPLE/x', 'Unknown URL'],
    ['an unknown www url in a Markdown link', '[x](https://www.evil.example)', 'Unknown URL'],
    [
      'an unknown url that carries a collected www url in its query',
      `see https://good.example/a?u=${DOCKER_URL}`,
      'Unknown URL',
    ],
    ['a collected url with a longer path', `see ${DOCKER_URL}evil`, 'Unknown URL'],
    [
      'a www host that only starts like a collected one',
      'see https://www.docker.com.evil.example/',
      'Unknown URL',
    ],
  ])('rejects %s', (_name, extra, kind) => {
    const result = checkWith(extra);

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain(kind);
  });

  it.each([
    ['a bare www host', 'see www.evil.example'],
    ['a bare www link with a path', 'see www.evil.example/payload'],
    [
      'the scheme-less form of a collected www url',
      'see www.docker.com/blog/docker-sandbox-kit-spec-cncf/',
    ],
    ['an upper-case bare www host', 'see WWW.EVIL.EXAMPLE'],
    ['a www host in a Markdown link', '[x](www.evil.example)'],
    ['a www host in an href', '<a href=www.evil.example>x</a>'],
    ['a protocol-relative www link', '[x](//www.evil.example)'],
    ['a www link after a scheme of another kind', 'see ftp://www.evil.example/x'],
    ['a www link with one slash after https:', 'see https:/www.evil.example'],
    ['a www link with no slash after https:', 'see https:www.evil.example'],
    ['a www link with no slash after http:', '[x](http:www.evil.example)'],
    ['a scheme with no slashes and no www', 'see http:evil.example'],
    ['a scheme with no slashes in a Markdown link', '[x](https:evil.example)'],
    ['a www host in a collected url after ftp://', 'see ftp://www.docker.com/blog/x/'],
    ['a www host after a tab behind https://', `see https://\twww.docker.com/blog/x/`],
    ['a www link right after a collected url and a bracket', `${DOCKER_URL}<www.evil.example>`],
    ['a www link right after a collected url and a parenthesis', `(${DOCKER_URL})www.evil.example`],
  ])('rejects %s as malformed', (_name, extra) => {
    const result = checkWith(extra);

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('Malformed or scheme-less link');
  });

  it('names only the bad link when a valid www url sits next to a scheme-less one', () => {
    const result = checkWith(`${DOCKER_URL} and www.evil.example/x`);

    expect(result.problems).toEqual(['Malformed or scheme-less link: www.evil.example/x']);
  });
});

describe('linkCheck: a www. anywhere in a collected url is part of that url', () => {
  const odd = [
    makeItem({ url: 'https://dk.example/www.x' }),
    makeItem({ url: 'https://dk.example/r?u=www.y.example' }),
    makeItem({ url: 'https://sub.www.dk.example/b' }),
    makeItem({ url: 'https://my-www.dk.example/c' }),
  ];

  it('passes the digest the renderer writes for urls with www in the path, query or host', () => {
    const digest = makeDigest(odd);

    expect(linkCheck(digest, render(digest), odd)).toEqual({ ok: true, problems: [] });
  });

  it.each([
    ['in the path', 'https://dk.example/www.other'],
    ['in the query', 'https://dk.example/r?u=www.other.example'],
    ['in a subdomain', 'https://other.www.dk.example/b'],
  ])('still rejects an unknown url with www %s', (_name, url) => {
    const result = checkWith(`see ${url}`, odd);

    expect(result.ok).toBe(false);
    expect(result.problems).toContain(`Unknown URL not in collected items: ${url}`);
  });

  it('reports an unknown https://www. url once, as unknown and not also as malformed', () => {
    const result = checkWith('see https://www.evil.example/x');

    expect(result.problems).toEqual([
      'Unknown URL not in collected items: https://www.evil.example/x',
    ]);
  });

  it('still finds a scheme-less link next to a collected url that has www in its path', () => {
    const result = checkWith('https://dk.example/www.x and www.evil.example/y', odd);

    expect(result.problems).toEqual(['Malformed or scheme-less link: www.evil.example/y']);
  });
});
