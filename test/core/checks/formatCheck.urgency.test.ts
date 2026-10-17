import { describe, expect, it } from 'vitest';
import {
  DIGEST_ACTION_WORD_LIMIT,
  DIGEST_MAX_ACT_NOW,
  DIGEST_SUMMARY_WORD_LIMIT,
  DIGEST_WORD_LIMIT,
  formatCheck,
} from '../../../src/core/checks/formatCheck.js';
import { renderDigest } from '../../../src/core/render.js';
import type { Digest, DigestItem, Urgency } from '../../../src/core/schemas.js';
import { makeDigest, makeDigestItem, makeItem } from '../../builders.js';

const check = (digest: Digest) => formatCheck(digest, renderDigest(digest, { disabledGuards: [] }));
const words = (count: number): string => Array.from({ length: count }, () => 'word').join(' ');

/** A digest with one item per urgency; each has an action, unless it is good-to-know. */
function withUrgencies(urgencies: readonly Urgency[]): Digest {
  const base = makeDigest(urgencies.map(() => makeItem()));
  return {
    ...base,
    items: base.items.map((item, i) => {
      const urgency = urgencies[i]!;
      return {
        ...item,
        urgency,
        action: urgency === 'good-to-know' ? '' : 'Upgrade OpenTofu in CI and on laptops',
      };
    }),
  };
}

const withItem = (digest: Digest, index: number, patch: Partial<DigestItem>): Digest => ({
  ...digest,
  items: digest.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
});

describe('formatCheck urgency and action (W8-01)', () => {
  it('passes a digest whose items all carry an urgency and a short action', () => {
    const digest = withUrgencies(['act-now', 'worth-a-look', 'good-to-know']);

    expect(check(digest)).toEqual({ ok: true, problems: [] });
  });

  it.each([
    ['an empty action', ''],
    ['no action', undefined],
  ])('accepts a good-to-know item with %s', (_name, action) => {
    const digest = withItem(withUrgencies(['good-to-know', 'act-now', 'act-now']), 0, { action });

    expect(check(digest).ok).toBe(true);
  });

  it.each<[Urgency, string | undefined]>([
    ['act-now', undefined],
    ['act-now', ''],
    ['act-now', '   '],
    ['worth-a-look', undefined],
    ['worth-a-look', ''],
  ])('rejects a %s item whose action is %j', (urgency, action) => {
    const digest = withItem(withUrgencies(['good-to-know', 'good-to-know', 'good-to-know']), 1, {
      urgency,
      action,
    });

    const result = check(digest);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['Missing action in item 2']);
  });

  it('names every item without an action in one problem, so a retry keeps room for the others', () => {
    const digest = withUrgencies(['act-now', 'worth-a-look', 'act-now', 'good-to-know']);
    const bare = {
      ...digest,
      items: digest.items.map((item) => ({ ...item, action: undefined })),
    };

    expect(check(bare).problems).toEqual(['Missing action in items 1, 2, 3']);
  });

  it('accepts an action of exactly the word limit and rejects one word more', () => {
    const base = withUrgencies(['act-now', 'worth-a-look', 'good-to-know']);

    expect(check(withItem(base, 0, { action: words(DIGEST_ACTION_WORD_LIMIT) })).ok).toBe(true);
    const result = check(withItem(base, 0, { action: words(DIGEST_ACTION_WORD_LIMIT + 1) }));

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      `Expected at most ${DIGEST_ACTION_WORD_LIMIT} words in the action of item 1, got ${DIGEST_ACTION_WORD_LIMIT + 1}`,
    ]);
  });

  it('checks the length of a good-to-know action too, when the writer gives one', () => {
    const base = withUrgencies(['act-now', 'worth-a-look', 'good-to-know']);

    const result = check(withItem(base, 2, { action: words(DIGEST_ACTION_WORD_LIMIT + 5) }));

    expect(result.problems).toEqual([expect.stringContaining('action of item 3')]);
  });

  it('accepts a summary of exactly the word limit and rejects one word more', () => {
    const base = withUrgencies(['act-now', 'worth-a-look', 'good-to-know']);

    expect(check(withItem(base, 1, { summary: words(DIGEST_SUMMARY_WORD_LIMIT) })).ok).toBe(true);
    const result = check(withItem(base, 1, { summary: words(DIGEST_SUMMARY_WORD_LIMIT + 1) }));

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      `Expected at most ${DIGEST_SUMMARY_WORD_LIMIT} words in the summary of item 2, got ${DIGEST_SUMMARY_WORD_LIMIT + 1}`,
    ]);
  });

  it('allows up to the act-now cap and rejects one more', () => {
    const atCap = withUrgencies(
      Array.from({ length: 5 }, (_, i): Urgency =>
        i < DIGEST_MAX_ACT_NOW ? 'act-now' : 'good-to-know',
      ),
    );
    const overCap = withUrgencies(
      Array.from({ length: 5 }, (_, i): Urgency =>
        i <= DIGEST_MAX_ACT_NOW ? 'act-now' : 'good-to-know',
      ),
    );

    expect(check(atCap).ok).toBe(true);
    expect(check(overCap).problems).toEqual([
      `Expected at most ${DIGEST_MAX_ACT_NOW} act-now items, got ${DIGEST_MAX_ACT_NOW + 1}`,
    ]);
  });

  it('keeps the act-now cap at 3, the number the spec and the write prompt state', () => {
    expect([DIGEST_MAX_ACT_NOW, DIGEST_ACTION_WORD_LIMIT, DIGEST_SUMMARY_WORD_LIMIT]).toEqual([
      3, 20, 40,
    ]);
  });

  it.each([
    ['a full url', 'Read https://example.com/posts/1 first'],
    ['a scheme-less host', 'Read www.example.com/posts/1 first'],
    ['a protocol-relative link', 'Read //example.com/posts/1 first'],
    ['an ftp url', 'Fetch ftp://evil.example/patch now'],
    ['a file url', 'Open file:///etc/passwd'],
    ['a mailto link', 'Write to mailto:a@evil.example'],
    ['a javascript link', 'Click javascript:alert(1)'],
    ['a Markdown link to any scheme', 'Read [the notes](ftp://evil.example/x)'],
    ['a Markdown link with a relative target', 'Read [the notes](/notes)'],
    ['an encoded scheme', 'Read h&#116;tps://evil.example'],
  ])('rejects an action with %s, since an action is one plain line', (_n, action) => {
    const digest = withItem(withUrgencies(['act-now', 'worth-a-look', 'good-to-know']), 0, {
      action,
    });

    const result = check(digest);

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(['Action of item 1 contains a link']);
  });

  it.each([
    'Upgrade to v1.2.3, e.g. in CI',
    'Relevant if you run Node.js 22.x or www-less proxies',
    'Pin the base image: ubuntu:24.04',
    'Read the data: it is short',
    'Use a/b testing for 50% of users',
  ])('accepts a plain action that only looks a little like a link: %s', (action) => {
    const digest = withItem(withUrgencies(['act-now', 'worth-a-look', 'good-to-know']), 0, {
      action,
    });

    expect(check(digest).ok).toBe(true);
  });

  it('stays fast on a long run of scheme-like characters', () => {
    const digest = withItem(withUrgencies(['act-now', 'worth-a-look', 'good-to-know']), 0, {
      action: 'a.'.repeat(50_000),
    });
    const started = performance.now();

    check(digest);

    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('reports every new problem at once, in item order', () => {
    const digest = withItem(
      withItem(withUrgencies(['act-now', 'act-now', 'act-now', 'act-now']), 0, { action: '' }),
      1,
      { summary: words(DIGEST_SUMMARY_WORD_LIMIT + 3) },
    );

    const result = check(digest);

    expect(result.problems).toEqual([
      'Missing action in item 1',
      `Expected at most ${DIGEST_SUMMARY_WORD_LIMIT} words in the summary of item 2, got ${DIGEST_SUMMARY_WORD_LIMIT + 3}`,
      `Expected at most ${DIGEST_MAX_ACT_NOW} act-now items, got 4`,
    ]);
  });
});

describe('formatCheck on drafts written before W8-01', () => {
  const old = makeDigest([makeItem(), makeItem(), makeItem()]);

  it('passes items with no urgency and no action: they read as worth-a-look with whyItMatters', () => {
    expect(old.items.every((item) => item.urgency === undefined && item.action === undefined)).toBe(
      true,
    );

    expect(check(old)).toEqual({ ok: true, problems: [] });
  });

  it('does not count old items toward the act-now cap', () => {
    const many = makeDigest(Array.from({ length: 5 }, () => makeItem()));

    expect(check(many).ok).toBe(true);
  });

  it('does not apply the summary limit, which the old writer prompt never gave', () => {
    const long = {
      ...old,
      items: [
        makeDigestItem(makeItem(), { summary: words(DIGEST_SUMMARY_WORD_LIMIT + 30) }),
        ...old.items.slice(1),
      ],
    };

    expect(check(long)).toEqual({ ok: true, problems: [] });
  });

  it('still refuses a link in an action, whatever the urgency', () => {
    const odd = withItem(old, 0, { action: 'See https://evil.example/x' });

    expect(check(odd).problems).toEqual(['Action of item 1 contains a link']);
  });

  it('rejects an old item with no whyItMatters, its stand-in action', () => {
    const digest = withItem(old, 0, { whyItMatters: ' ' });

    expect(check(digest).problems).toEqual(['Missing why-it-matters in item 1']);
  });
});

describe('formatCheck word limit and the layout (W8-02 reshapes the Markdown)', () => {
  const digest = withUrgencies(['act-now', 'worth-a-look', 'good-to-know']);
  const table = ['| Item | Action |', '| --- | --- |', '| a | b |'].join('\n');

  it('does not count table pipes, separator rows, rules or bullets as words', () => {
    const rows = Array.from({ length: 150 }, () => '| --- | --- | --- |').join('\n');
    const markdown = [words(DIGEST_WORD_LIMIT - 50), table, rows, '---\n\n> - * # ##'].join('\n');

    expect(formatCheck(digest, markdown)).toEqual({ ok: true, problems: [] });
  });

  it('counts the words in table cells, with or without spaces around the pipes', () => {
    // 300 lines: 600 words when a pipe separates them, but only 300 tokens when it does not.
    const cells = Array.from({ length: 300 }, () => '|word|word').join('\n');

    expect(formatCheck(digest, cells).problems).toEqual([
      expect.stringContaining(`under ${DIGEST_WORD_LIMIT} words`),
    ]);
  });

  it('counts a word that is only digits, such as a version or a year', () => {
    const markdown = Array.from({ length: DIGEST_WORD_LIMIT }, () => '2026').join(' ');

    expect(formatCheck(digest, markdown).ok).toBe(false);
  });

  it('still rejects exactly the limit and accepts one word under it', () => {
    expect(formatCheck(digest, words(DIGEST_WORD_LIMIT - 1)).ok).toBe(true);
    expect(formatCheck(digest, words(DIGEST_WORD_LIMIT)).ok).toBe(false);
  });
});
