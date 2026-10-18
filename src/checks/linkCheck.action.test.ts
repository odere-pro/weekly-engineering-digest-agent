import { describe, expect, it } from 'vitest';
import { linkCheck } from './linkCheck';
import { renderDigest } from '../render/markdown';
import type { Digest } from '../domain/schemas';
import { makeDigest, makeItem } from '../../test/builders';

const items = [makeItem(), makeItem(), makeItem()];

/** The first item gets `action`; the Markdown is whatever the renderer makes of the digest. */
function withAction(action: string | undefined): { digest: Digest; markdown: string } {
  const digest = makeDigest(items);
  const first = { ...digest.items[0]!, urgency: 'act-now' as const, action };
  const changed = { ...digest, items: [first, ...digest.items.slice(1)] };
  return { digest: changed, markdown: renderDigest(changed, { disabledGuards: [] }) };
}

describe('linkCheck reads the action line (W8-01)', () => {
  it('flags a URL in an action that is not a collected item, even when the Markdown does not show it', () => {
    const { digest, markdown } = withAction('Read https://evil.example.org/x first');

    const result = linkCheck(digest, markdown, items);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      'Unknown URL not in collected items: https://evil.example.org/x',
    ]);
  });

  it('flags a Markdown link destination in an action', () => {
    const { digest, markdown } = withAction('See [the notes](https://evil.example.org/n)');

    const result = linkCheck(digest, markdown, items);

    expect(result.problems).toEqual([
      'Unknown URL not in collected items: https://evil.example.org/n',
    ]);
  });

  it.each([
    ['a scheme-less www host', 'Read www.evil.example.org/x', 'www.evil.example.org/x'],
    ['a protocol-relative link', 'Read //evil.example.org/x', '//evil.example.org/x'],
  ])('flags %s in an action', (_name, action, link) => {
    const { digest, markdown } = withAction(action);

    const result = linkCheck(digest, markdown, items);

    expect(result.problems).toEqual([`Malformed or scheme-less link: ${link}`]);
  });

  it('flags a character reference outside the Unicode range in an action', () => {
    const { digest, markdown } = withAction('Upgrade &#99999999999; now');

    expect(linkCheck(digest, markdown, items).ok).toBe(false);
  });

  it('accepts a collected URL in an action', () => {
    const { digest, markdown } = withAction(`Read ${items[0]!.url} first`);

    expect(linkCheck(digest, markdown, items)).toEqual({ ok: true, problems: [] });
  });

  it('flags a collected URL with an uncollected path after it', () => {
    const { digest, markdown } = withAction(`Read ${items[0]!.url}/extra first`);

    expect(linkCheck(digest, markdown, items).problems).toEqual([
      `Unknown URL not in collected items: ${items[0]!.url}/extra`,
    ]);
  });

  it.each([undefined, '', 'Upgrade OpenTofu in CI and on laptops'])(
    'passes an action that holds no link: %j',
    (action) => {
      const { digest, markdown } = withAction(action);

      expect(linkCheck(digest, markdown, items)).toEqual({ ok: true, problems: [] });
    },
  );
});
