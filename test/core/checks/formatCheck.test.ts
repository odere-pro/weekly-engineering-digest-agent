import { describe, expect, it } from 'vitest';
import { formatCheck } from '../../../src/core/checks/formatCheck.js';
import { renderDigest } from '../../../src/core/render.js';
import type { Digest } from '../../../src/core/schemas.js';
import { makeDigest, makeItem } from '../../builders.js';

const check = (digest: Digest) => formatCheck(digest, renderDigest(digest, { disabledGuards: [] }));
const digestOf = (n: number): Digest => makeDigest(Array.from({ length: n }, () => makeItem()));
const withFirst = (d: Digest, patch: Partial<Digest['items'][number]>): Digest => ({
  ...d,
  items: [{ ...d.items[0]!, ...patch }, ...d.items.slice(1)],
});

describe('formatCheck', () => {
  it.each([3, 4, 5])('passes a clean digest with %i items', (n) => {
    expect(check(digestOf(n))).toEqual({ ok: true, problems: [] });
  });

  it.each([2, 6])('rejects %i items', (n) => {
    const result = check(digestOf(n));

    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('3-5 items');
  });

  it.each([
    ['headline', (d: Digest): Digest => ({ ...d, headline: ' ' })],
    ['intro', (d: Digest): Digest => ({ ...d, intro: '' })],
    ['summary', (d: Digest): Digest => withFirst(d, { summary: '' })],
    ['why-it-matters', (d: Digest): Digest => withFirst(d, { whyItMatters: '  ' })],
  ])('rejects an empty %s', (name, mutate) => {
    const result = check(mutate(digestOf(3)));

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain(name);
  });

  it('rejects an em dash', () => {
    const result = check(withFirst(digestOf(3), { summary: 'Fast — very fast.' }));

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('em dash');
  });

  it('rejects 500 or more words', () => {
    const result = check(withFirst(digestOf(3), { summary: 'word '.repeat(500) }));

    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('500 words');
  });

  it('does not count link targets as words', () => {
    const d = withFirst(digestOf(3), { summary: 'word '.repeat(380) });
    const md = renderDigest(d, { disabledGuards: [] });
    const long = `${md}\n[x](https://example.com/${'a/'.repeat(400)})`;

    expect(formatCheck(d, long).ok).toBe(true);
  });

  it('reports several problems at once', () => {
    const result = check({ ...digestOf(2), headline: '' });

    expect(result.problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe('formatCheck word limit', () => {
  it('counts prose hidden between "](" and ")"', () => {
    const d = digestOf(3);
    const md = `${renderDigest(d, { disabledGuards: [] })}\nfoo](${'word '.repeat(600)})`;

    expect(formatCheck(d, md).ok).toBe(false);
  });
});
